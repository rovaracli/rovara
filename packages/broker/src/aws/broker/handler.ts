// Part of the broker (split out of ../broker.ts): createAwsBrokerHandler: the request router.

import { fixtureStoreForRoutes } from "../../test-env/fixture-store-aws.js";
import { noteInvokedFunctionArn } from "../../test-env/lambda-identity.js";
import { EVIDENCE_RESUME_BUDGET_MS, evidenceEraseOf, resumeEvidence } from "./evidence-wiring.js";
import { runCompanyDomainRecheck } from "../../org/company-domains/recheck.js";
import { TaskStopReadinessError } from "../../org/task-stop-enrollment-common.js";
import { decisionCardsEnabled } from "../../proof/switch.js";
import { handleSlackDecisionPress, isSlackDecisionPressEvent } from "./decision-press.js";
import { handleAskServiceRoute, installSlackAsk, linearCommentIntakeOf, runAskMaintenance } from "./ask-service.js";
import { diagnosisDefaultBranchFileRoute, handleDiagnosisServiceRoute, installDiagnosisService } from "./diagnosis-service.js";
import { requireStaffRouteAllowed } from "./staff-routes.js";
import { routeSecondReviewEvidence } from "./second-review-evidence-routes.js";
import { isSlackWorkflowRevisePlanEvent } from "../../agent-sessions/live-steer-revise.js";
import { ProcessModelRefusal, processModelRefusalBody } from "../../model-selection/process-refusal.js";
import { TASK_PAGE, TASK_PEOPLE_CONFIRMATION } from "../task-web.js";
import { legacyHostRedirect } from "../../developer/legacy-host-redirect.js";
import { withDecideIsolation } from "../../developer/confirm-page.js";
import { authenticateWebRequest, webRouteAllowed } from "../web-auth.js";
import { appCsrfTokenFor } from "../../developer/app-csrf.js";
import { createHash } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { AgentXError, E2ESetupProposalSchema, inspectE2ERepository, proposeE2ESetup, WEB_API_RUNTIME_PROFILE_ID, verifyE2ESourceSnapshot, verifyE2ESetupProposal, canonicalJson, agentXError, projectSetupApprovalKey, type OrgId, isAdminChangePressEvent, type AdminChangePressEvent, sameJsonContent, type E2ESourceSnapshot, E2E_AGENT_UNAVAILABLE_REASONS, E2E_MODEL_ROUTE_CHANGED_REAPPROVE } from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../../auth.js";
import { routeAdminRead } from "../admin-reads.js";
import { pressAdminChange, routeAdminChange } from "../admin-changes.js";
import { z } from "zod";
import { runAuditDrain } from "../../audit/drain.js";
import { routeAuditAdminRequest } from "../../audit/admin-routes.js";
import { isAuditViewPath } from "../../audit/view-page.js";
import type { InstallationLifecycleEvent } from "../../org/github-connection.js";
import { isWebhookSecretMissing } from "../../github-app.js";
import { GITHUB_WEBHOOK_SIGNATURE_INVALID, GithubWebhookRefusal, GithubWebhookRetryableError, authorizeLinkedGithubWebhook, handleGithubWebhook } from "../github-webhooks.js";
import { observeConnectorRoute } from "../connector-metrics.js";
import { stripCode } from "../connector-routes.js";
import { applyInstallationLifecycle, requireRepositoryConnected } from "../../org/github-connection.js";
import { bindRequestedInstallation, drainInstallNoticeOutbox, sendInstallRequestReminders } from "../../org/github-install-requests.js";
import { isGithubInstallPath, routeGithubInstall } from "../github-install-web.js";
import { readObjectText as readStoredText } from "../../developer/plan-artifacts.js";
import { deliverDueCodeMilestones } from "../../rovara-code/milestones.js";
import { requireOrgId } from "../../org/resolve.js";
import { runEgressDomainsSync } from "../egress-domains-sync.js";
import { issueRuntimeInstallChallenge, registerRuntimeInstallation, type RuntimeInstallationDependencies } from "../runtime-installation.js";
import { readE2ERuntimeStatus, readReadyE2ERuntimeProfiles } from "../e2e-runtime-readiness.js";
import { getItem } from "../cancellation.js";
import { registerAgentSessionTaskHandlers } from "../../agent-sessions/index.js";
import { taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { E2EModelRouteError, agentRouteSummary, approveE2EAgentRoute, type E2EAgentInstallation } from "../../e2e/model-route-registry.js";
import { sweepModelSources } from "../../model-sources/sweep.js";
import { answerSlackChatGpt, isSlackChatGptCommandEvent, isSlackChatGptFinishEvent } from "../slack-chatgpt.js";
import { HookStore } from "../../triggers/hooks.js";
import { receiveHook } from "../../triggers/ingress.js";
import { hookProviders } from "../../triggers/providers/index.js";
import type { settlementBudgets } from "../../spend/settlement-job.js";
import { redriveUntil, runSettlementJobs, runSpendSweep, timedSettlementJob, type SettlementJob } from "../../spend/settlement-job.js";
import { runApprovalSweep } from "../../agents/approvals.js";
import { memberRemovalHook, onProjectArchived, onProjectMemberChanged, runMemberMergeDrain } from "../../agents/lifecycle.js";
import { escalateOwnerRequests } from "../../spend/requests.js";
import { fireChainSchedule, sweepSchedules } from "../../triggers/schedules.js";
import { runIntakePoll } from "../../triggers/poll-intake.js";
import { deliverGithubTriggerEvents, type AuthorQuery } from "../../triggers/github-events.js";
import { sweepChainRuns } from "../../chains/lifecycle.js";
import type { ChainRouteDependencies } from "../../chains/routes.js";
import { chainSessionSource } from "../../chains/session-seam.js";
import { drainEndedSessions, sweepAgentSessions } from "../../agent-sessions/sweep.js";
import { redirectSweepBudgetMs, redirectSweepReserveMs, sweepRedirects } from "./redirect-runtime.js";
import { installRealtimeSink, realtimeConfigFromEnvironment } from "../../realtime/sink.js";
import { DecideReauthRequired } from "../../developer/decide-session.js";
import { answerDecideInspect, isDecideInspectEvent, type DecideInspectEvent } from "../../developer/decide-inspect.js";
import { isDecidePagePath, routeDecidePage } from "../decide-web.js";
import { developerReply, json } from "../json-reply.js";
import { routeDeveloperRequest, type DeveloperCaller, type DeveloperRouteDependencies } from "../developer-routes.js";
import { releasePendingFinishedTasks } from "../developer-tasks.js";
import { runDueWorkflowMergeRecovery, runDueWorkflowMergeTracking } from "../workflow-merge-recovery.js";
import { mergeViewOf } from "../../rovara-code/merge.js";
import type { MergeTrackingItem } from "@agentx/contracts";
import { resolveHeadEventTask } from "../../rovara-code/tracking-events.js";
import { adaptHttpApiEvent, identityFromJwtClaims, type HttpApiV2Event } from "../lambda.js";
import { getSwebenchRunForThread, handleSwebenchCallback, isSwebenchCallbackPath, startSwebenchRun } from "../swebench.js";
import { dropWatchedBatch, listWatchedBatches, recordWatchedBatchThread, startSlackBatch, updateWatchedBatch } from "../eval-batch-service.js";
import { cancelWorkspaceTask, stopWorkspace } from "./acceptance.js";
import { exchangeRegistryCredential } from "./registry-credentials.js";
import { exchangeSavedEnvLogin } from "./saved-env-login.js";
import { handleSavedEnvFallback } from "./saved-env-lease.js";
import { runSavedEnvPoll, savedEnvBeforeNightly, savedEnvPushQueue } from "./saved-env-triggers.js";
import { sweepSavedEnvBuilds } from "./saved-env-sweep.js";
import { savedEnvEnabled } from "../../test-env/saved-env-switch.js";
import { HOOK_DELIVERY_PATH, HOOK_ROUTE_KEY, adminModelChecks, adminTaskE2EReplay, adminTaskShareMode, connectedAwsAccountsOf, exchangeRepositoryCredential, hookMemoryOf, hookReply, optional, parseBody, routeEvalBatch, routeStartEvalBatch, routeSwebenchChannel, swebenchDependencies, swebenchSlackContext } from "./admin-and-helpers.js";
import { handleCallback } from "./callbacks.js";
import { APP_ROUTE_KEY, DEVELOPER_ROUTE_KEY, DOT_SEGMENT, FEEDBACK_REVIEW_ROUTE_KEY, MAX_SETUP_PROPOSAL_BYTES, WEB_ROUTE_KEY, plannedAgentRoute, projectSetupPolicy, untestedAgentRouteNote, type AwsBrokerInput } from "./definitions.js";
import { installLearningTaskEnd } from "./learning-wiring.js";
import { designReviewPortsOf } from "../../design-review/wiring.js";
import { answerSlackAdd, applyTeamRecordRemoval, drainTeamRecordQueue, installTeamRecordEmitter, isTeamRecordJobEvent, isTeamRecordQueueEvent, isTeamRecordRemovalEvent, isTeamRecordSlackAddEvent, isTeamRecordSlackEvent, recordSlackForward, runTeamRecordJob } from "./team-record-wiring.js";
import { installLessons, recordAndLessonRouteDependencies } from "./lessons-wiring.js";
import { requireSlackAllowedByEdition, removalDepsOf, slackTeamOrg, adminChangeDependencies, adminReadDependencies, agentRouteDependencies, brokerDependencies, chainRunnerDependenciesOf, developerDisplayName, developerTaskActions, eventDispatchOf, githubConnectRoute, githubConnectionOf, installChainRunner, installOwnWriteRecorder, intakePollDependenciesFrom, orgStoreOf, repositoriesGateRoute, repositoryGateOf, serviceStatusRouteDependencies, workingBranchPagesRoute, workingBranchPreviewRoute } from "./dependency-wiring.js";
import { runWokenTrackingPass, trackingPassDependencies } from "./e2e-rounds.js";
import { handleProjectSetupCallback, handleProjectSetupEvidenceChunk, handleProjectSetupEvidenceFinalize, handleProjectSetupEvidenceInit, handleProjectSetupExecutionRead } from "./evidence-and-setup.js";
import { handleModelAccess, handleSlackModelAccess } from "./model-access.js";
import { metaConfigQueueFor, metaRepoRouteDependencies } from "./meta-repo-wiring.js";
import { createCloudProject, prepareWorkspace, registerProject, registerProjectFor, retryProjectSetupAsAdministrator } from "./project-registration.js";
import { getProjectModels, putProjectModel } from "./records.js";
import { decideEgress, decideRequestContext, egressDepsOf, githubScope, listEgressPending, orgConnectionStoreOf, orgResolverOf, putInstallBudget, routingOf, webhookRepositoryUrl } from "./scope-helpers.js";
import { authorizeSlackTaskAction, captureSlackWorkflowFeedbackNote, closeSlackWorkflowTask, confirmSlackTaskPeople, decideSlackWorkflow, decideSlackWorkflowFeedbackFindings, handleSlackTaskPeople, isSlackStopTaskEvent, isSlackTaskAuthorizationEvent, isSlackTaskPeopleChangeEvent, isSlackTaskPeopleConfirmEvent, isSlackTaskPeopleReadEvent, isSlackTaskPeopleTakeOwnershipEvent, isSlackThreadNoteEvent, isSlackWorkflowCloseEvent, isSlackWorkflowDecisionEvent, isSlackWorkflowFeedbackFindingsDecisionEvent, isSlackWorkflowFeedbackNoteEvent, isSlackWorkflowFeedbackReviewRetryEvent, isSlackWorkflowKeepPullRequestsEvent, isSlackWorkflowPublishRetryEvent, isSlackWorkflowResolveFindingsEvent, isSlackWorkflowRetryEvent, isSlackWorkflowReviewRetryEvent, isSlackWorkflowSendBackEvent, isSlackWorkflowStartEvent, reviseSlackWorkflowPlan, keepSlackWorkflowPullRequests, recordSlackThreadNote, resolveSlackWorkflowFindings, retrySlackWorkflowChecks, retrySlackWorkflowFeedbackReview, retrySlackWorkflowPublication, retrySlackWorkflowReviews, sendSlackWorkflowBack, startSlackWorkflow, stopSlackThreadTask, workflowApplicationRouteDependencies, type SlackStopTaskEvent, type SlackTaskAuthorizationEvent, type SlackTaskPeopleChangeEvent, type SlackTaskPeopleConfirmEvent, type SlackTaskPeopleReadEvent, type SlackTaskPeopleTakeOwnershipEvent, type SlackWorkflowCloseEvent, type SlackWorkflowDecisionEvent, type SlackWorkflowResolveFindingsEvent, type SlackWorkflowRetryEvent, type SlackWorkflowReviewRetryEvent, type SlackWorkflowSendBackEvent, type SlackWorkflowStartEvent } from "./slack-workflow-events.js";
import { fireTestEnvNightly, isTestEnvNightlyEvent } from "../../test-env/nightly-wiring.js";
import { nightlyRunsOf, sweepAutomaticRunsOf } from "./nightly-run-wiring.js";
import { SESSION_EVENT_BUDGET_MS, auditModelKeys, isAuditDrainEvent, isChainScheduleEvent, isChainSweepEvent, isEgressDomainsSyncEvent, isIntakePollEvent, isGithubInstallRequestReminderEvent, isGithubWebhookRecoveryEvent, isSessionSweepEvent, isSpendSettlementEvent, isWorkflowMergeRecoveryEvent, ledgerOf, modelSourceSweepOf } from "./sweeps-and-readiness.js";
import { handleAgentSkills, handleAgentTools } from "./task-operations.js";
import { handleContextTools } from "./context-tools.js";
import { handleDesignReviewPacket } from "./design-review-packet-route.js";
import { SWEEP_EVENT_BUDGET_MS, headEventDependencies, processGithubWorkflowEvent, reconcileWorkflowMergeRecoveryTask, retryDueGithubWebhookEvents, retryGithubWebhookAsAdministrator } from "./terminal-and-github-events.js";
import { completeThreadWorkspaceClose, ensureThreadWorkspace, markCommentAnswered, markThreadNoteAnswered, prepareThreadWorkspace, startThreadWorkspaceClose } from "./thread-workspaces.js";
import { routeEditionDependencies } from "../../wiring/enterprise-identity.js";
import { isWorkflowDispatchRecoveryEvent, retryDueWorkflowDispatches, startDuePlanEvidenceJobs } from "./workflow-items.js";
import { connectSlackTeam, deleteSlackBinding, disconnectSlackTeam, getTeamSlackBinding, putSlackBinding, requireSlackRequesterMayWork, requireSlackServiceRole, slackServiceIdentity } from "./workspace-preparation.js";
import { SLACK_APPROVAL_OUT_OF_DATE, SLACK_BUTTON_OUT_OF_DATE, answerSlackWorkflowEvent, replyNotSavedAnswer, routeWorkspaceRequest, unexpectedErrorAnswer } from "./workspace-routes.js";
import { OUTCOME_SETTLE_PASS_MS, releaseDependenciesOf } from "./terminal-and-github-events.js";
import { auditOperatorId } from "@agentx/contracts";
import { learningFirstTick } from "../../spend/settlement-job.js";
import { learningWalkDeps, resumeOpenLearningWalks } from "../../learning/cleanup.js";
import { requirePricedTaskStopAdmission } from "../../org/task-stop-unpriced.js";
import { installSettingsProofSettler } from "../developer-routes/settings-proof-hook.js";
import { settleSettingsProofOfCheck, sweepSettingsProofs } from "../developer-routes/settings-proof.js";

export function createAwsBrokerHandler(input: AwsBrokerInput) {
  const dependencies = brokerDependencies(input);
  if (Buffer.byteLength(dependencies.callbackSigningKey, "utf8") < 32) {
    throw new Error("CALLBACK_SIGNING_KEY must contain at least 32 bytes");
  }
  // Spec 025: the broker actions the developer task routes call, built once per handler.
  const tasks = developerTaskActions(dependencies);
  const agents = agentRouteDependencies(dependencies, tasks);
  installChainRunner(dependencies, tasks, agents);
  installOwnWriteRecorder(dependencies);
  installLearningTaskEnd(dependencies);
  installLessons(dependencies);
  installTeamRecordEmitter(dependencies);
  installSlackAsk(dependencies, tasks, agents?.agentSessions);
  installDiagnosisService(dependencies, agents?.agentSessions);
  // Plan 5, Task 7b: a session follows its task's end and budget pause as Plan 3 tells them, instead of waiting for the stream or the sweep. Only where agents are set up
  // (sessions begin there); a broker without them registers nothing, so Plan 3's "nobody listens" behaviour is unchanged. Plan 4's chain and Task 18's device reads are given
  // here when those land (the sweep's event passes them the same way).
  if (agents !== undefined) {
    registerAgentSessionTaskHandlers({ chains: chainSessionSource(agents as ChainRouteDependencies) });
    // Plan 5, Task 8: what a session's change turns into: each person's feed, and a notice on the events API where there is one. Plan 4's chain readers judge a chain session's followers.
    installRealtimeSink({ realtime: realtimeConfigFromEnvironment(), chainReadAccess: agents.agentSessions?.chainReadAccess });
  }
  const adminReads = adminReadDependencies(dependencies);
  const adminChanges = adminChangeDependencies(dependencies, adminReads);
  // TE-4: the developer API's dependencies, built the same way for a request and for the settling of a project's settings proof when a check reports (no request in sight).
  const developerRouteDependencies = (): DeveloperRouteDependencies | undefined => {
    if (!dependencies.developer) return undefined;
        const orgConnections = orgConnectionStoreOf(dependencies);
        const routeDependencies: DeveloperRouteDependencies = { documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: dependencies.developer, now: Date.now, tasks,
          orgs: orgStoreOf(dependencies, agents === undefined ? undefined : memberRemovalHook(removalDepsOf(agents, dependencies))),
          // Plan 3, Task 11: an archived project's agents (its roster and its own agents) stay as they are; this says what was left standing.
          ...(agents === undefined ? {} : { projectArchived: async (orgId: OrgId, project: string) => { await onProjectArchived(agents, { orgId, project }); } }),
          ...(agents === undefined ? {} : { projectMemberChanged: async (orgId: OrgId, project: string, developerId: string) => { await onProjectMemberChanged(agents, { orgId, project, developerId }); } }),
          ...(dependencies.modelAccess === undefined ? {} : { modelAccess: dependencies.modelAccess.access }),
          ...(dependencies.cloud === true ? { cloud: true } : {}),
          ...routeEditionDependencies(dependencies),
          ...(dependencies.sso === undefined ? {} : { sso: dependencies.sso }),
          ...(dependencies.githubConnectedNotice === undefined ? {} : { ownerNotice: dependencies.githubConnectedNotice }),
          ...(dependencies.egressDomainsSync === undefined ? {} : { egressSync: dependencies.egressDomainsSync }),
          ...(dependencies.chatgpt === undefined ? {} : { chatgpt: dependencies.chatgpt }),
          // Saved project images: the project's Environment panel routes (only where the `sv` switch is on and the registry is installed).
          ...(dependencies.savedEnvDeps === undefined || !savedEnvEnabled() ? {} : { savedEnv: dependencies.savedEnvDeps }),
          // Team record (fix round 1: the first round put this in the review-page branch by mistake): the record routes, and its erase on project archive and company close, only where its switch is on.
          ...(dependencies.teamRecord === undefined ? {} : { teamRecord: dependencies.teamRecord }),
          // Test services (slice 1): the signed service image catalog the setup draft's dependency candidates are proposed from (only with the switch `tx` on).
          ...(dependencies.serviceCatalog === undefined ? {} : { serviceCatalog: dependencies.serviceCatalog }),
          // Test services, slice 3: the fixture store for the hand-written answer set routes (only with `tx` on and the install's fixture key).
          ...fixtureStoreForRoutes(dependencies),
          sessionDiffFiles: dependencies.githubPullRequests.listPullRequestFiles === undefined ? undefined : (url, number, options, scope) => dependencies.githubPullRequests.listPullRequestFiles!(url, number, options, githubScope(dependencies, scope.orgId)),
          createProject: (caller, input) => createCloudProject(dependencies, caller, input),
          ...(dependencies.auditLedger === undefined ? {} : { auditLedger: dependencies.auditLedger }),
          ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }),
          ...githubConnectRoute(dependencies),
          // Proof and evidence (wire-proof fix round 1): the stored evidence of an archived project or a closed company is deleted with it.
          evidenceErase: evidenceEraseOf(dependencies),
          ...(agents === undefined ? {} : { agents }),
          // Meta repo lane B: the setup agent's citations are re-read from GitHub, through the org's own installation.
          ...(dependencies.githubPullRequests.getFileAtCommit === undefined ? {} : {
            setupCitationReader: (orgId: OrgId, repositoryUrl: string, path: string, commit: string, options: { untilLine?: number; timeoutMs: number }) => dependencies.githubPullRequests.getFileAtCommit!(repositoryUrl, path, commit, githubScope(dependencies, orgId), options),
          }),
          // DG-1 S2: "Apply this change" checks a proposed dev container file against the default branch's head (wiring: the three GitHub reads, one line).
          ...diagnosisDefaultBranchFileRoute(dependencies),
          // Design review: the round's ports for the owner's Retry (a pure object; nothing is read until a round starts).
          designReview: designReviewPortsOf(dependencies),
          // Closing an org clears its connections whether or not the agent routes are set up (Task 12b).
          ...(orgConnections === undefined ? {} : { orgConnections }),
          ...repositoriesGateRoute(dependencies),
          ...workingBranchPagesRoute(dependencies),
          ...serviceStatusRouteDependencies(dependencies),
          ...workingBranchPreviewRoute(dependencies),
          projectAllowedDomains: {
            registerApproved: async (actor, value, proof) => registerProjectFor(dependencies, actor, value, { creatorMembership: "none", appliedDomainProposal: proof }),
          },
          projectSettings: {
            registerRevision: async (actor, input, extraItems) => { await registerProjectFor(dependencies, actor, input, { creatorMembership: "none", ...(extraItems === undefined ? {} : { extraItems, expectedBaseRevision: input.definition.revision - 1 }) }); },
            // Plan 2, Task 15: an added repository must be reached by the org's own GitHub connection (the installation GitHub says covers it, bound and active).
            ...(repositoryGateOf(dependencies) === undefined ? {} : {
              requireRepositoryConnected: (orgId: OrgId, owner: string, repository: string) => requireRepositoryConnected(repositoryGateOf(dependencies)!, orgId, owner, repository),
            }),
            ...(dependencies.cloudProjects === undefined ? {} : { githubCredentialRef: dependencies.cloudProjects.githubCredentialRef }),
            ...(dependencies.githubPullRequests.getRepositoryIdentity === undefined ? {} : {
              repositoryIdentity: (url: string, orgId: OrgId) => dependencies.githubPullRequests.getRepositoryIdentity!(url, githubScope(dependencies, orgId)),
            }),
          },
          ...workflowApplicationRouteDependencies(dependencies),
          // The Team record's `/record/` routes (they were wired only on the review page's branch) and the lessons routes; both empty where the record is off.
          ...recordAndLessonRouteDependencies(dependencies) };
        // Meta repo lane A: creating a project from a meta repo, and the meta repo's config file (reuses the settings route's own pieces).
        Object.assign(routeDependencies, metaRepoRouteDependencies(dependencies, routeDependencies.projectSettings));
    return routeDependencies;
  };
  installSettingsProofSettler((workspaceId) => settleSettingsProofOfCheck(developerRouteDependencies, workspaceId));
  return async (event: HttpApiV2Event | DecideInspectEvent | SlackStopTaskEvent | SlackTaskAuthorizationEvent | SlackTaskPeopleConfirmEvent | SlackTaskPeopleReadEvent | SlackTaskPeopleChangeEvent | SlackTaskPeopleTakeOwnershipEvent | SlackWorkflowStartEvent | SlackWorkflowDecisionEvent | SlackWorkflowRetryEvent | SlackWorkflowReviewRetryEvent | SlackWorkflowSendBackEvent | SlackWorkflowResolveFindingsEvent | SlackWorkflowCloseEvent | AdminChangePressEvent | { source: "agentx.github-webhook-recovery" } | { source: "agentx.egress-domains-sync" } | { kind: "github-install-request-reminders" } | { source: "agentx.workflow-dispatch-recovery" } | { source: "agentx.workflow-merge-recovery" } | { source: "agentx.spend-settlement" } | { source: "agentx.chain-sweep" } | { source: "agentx.intake-poll" } | { source: "agentx.session-sweep" } | { source: "agentx.audit-drain" }, context?: { awsRequestId?: string; invokedFunctionArn?: string; getRemainingTimeInMillis?: () => number }): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> => {
    // Test services: the account this function runs in, from the Lambda's own ARN (the catalog's trust decision reads it; nothing else does).
    noteInvokedFunctionArn(context?.invokedFunctionArn);
    // Enterprise foundations I-2: an install whose edition stamp is not its recorded edition serves nothing (every kind of event).
    await dependencies.editionGuard?.();
    // Plan 3, Task 21a-wiring (hand-off 1): the sign-in function asks whether a member may decide an approval, by a direct invoke (never through
    // API Gateway). The same live evaluation as the page, answered as one word (and the words for a refusal); a failure here is an error, never "open".
    if (isDecideInspectEvent(event)) {
      try {
        const answer = await answerDecideInspect(decideRequestContext(dependencies, agents)?.kinds ?? {}, event);
        return json(answer.body, "decide-inspect", answer.statusCode);
      } catch (error) {
        console.log(JSON.stringify({ component: "broker", event: "decide.inspect_failed", error: error instanceof Error ? error.name : "unknown" }));
        return json({ error: "inspect_failed" }, "decide-inspect", 500);
      }
    }
    // Spec 025 E14: a Slack Confirm or Cancel press, invoked directly by the ingress (never through API Gateway).
    if (isAdminChangePressEvent(event)) {
      if (adminChanges === undefined) return json({ error: { code: "NOT_FOUND", message: "admin changes are not set up in this deployment" } }, "slack-ingress", 404);
      try {
        return json(await pressAdminChange(adminChanges, event), "slack-ingress");
      } catch (error) {
        console.log(JSON.stringify({ component: "broker", event: "admin_change.press_failed", changeId: event.changeId, error: error instanceof AgentXError ? error.code : error instanceof Error ? error.name : "unknown" }));
        return json({ outcome: "failed", changeId: event.changeId }, "slack-ingress", 500);
      }
    }
    // The Audit Ledger's drain (R70): sends the pending audit items the flush after a commit did not deliver.
    if (isAuditDrainEvent(event)) {
      try { return json(await runAuditDrain(dependencies), "audit-drain"); }
      catch (error) {
        console.log(JSON.stringify({ component: "broker", event: "audit.drain_failed", level: "error", error: error instanceof Error ? error.name : "unknown" }));
        return json({ error: "drain_failed" }, "audit-drain", 500);
      }
    }
    // Plan 2, Task 14 Step 6: the hourly sweep that reminds a requester once, two days after they asked their GitHub admin.
    if (isGithubInstallRequestReminderEvent(event)) {
      try {
        const connection = githubConnectionOf(dependencies);
        if (connection === undefined) return json({ reminded: 0, cleared: 0, notices: 0 }, "github-install-request-reminders");
        // The same hourly run also drains the owners' notices and trial unlocks that a bind left behind. Each is tried even if the other fails.
        const reminders = await sendInstallRequestReminders(connection).then((result) => ({ ok: true as const, result }), (error: unknown) => ({ ok: false as const, error }));
        const outbox = await drainInstallNoticeOutbox(connection).then((result) => ({ ok: true as const, result }), (error: unknown) => ({ ok: false as const, error }));
        if (!reminders.ok) throw reminders.error;
        if (!outbox.ok) throw outbox.error;
        return json({ ...reminders.result, notices: outbox.result.drained }, "github-install-request-reminders");
      } catch (error) {
        console.log(JSON.stringify({ component: "broker", event: "github.install_request_reminders_failed", error: error instanceof Error ? error.name : "unknown" }));
        return json({ error: "reminders_failed" }, "github-install-request-reminders", 500);
      }
    }
    // Plan 5, Task 7a: every 5 minutes, the session sweep (refreshes the open sessions from a saved cursor) and then the retention drain. Each has its own deadline
    // and a failure of one never stops the other. Plan 4's chain reads are wired here; Task 18's device reads are given when that lands.
    if (isSessionSweepEvent(event)) {
      const table = { documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now };
      const outcome: Record<string, unknown> = {};
      const startedAt = Date.now();
      // A chain run's session is refreshed from Plan 4's run (its status, step, cost and who a gate waits for); the device reads of a local session are Task 18's.
      try { outcome.sweep = await sweepAgentSessions({ ...table, ...(agents === undefined ? {} : { chains: chainSessionSource(agents as ChainRouteDependencies) }) }, Date.now()); }
      catch (error) { console.log(JSON.stringify({ component: "broker", event: "agent_session.sweep_failed", error: error instanceof Error ? error.name : "unknown" })); outcome.sweep = "failed"; }
      // The function's timeout is 30 seconds: the drain gets what is left of 25 (a refresh or a page of updates that has started may run a second or two over).
      try { outcome.drain = await drainEndedSessions(table, Date.now(), { budgetMs: Math.max(0, SESSION_EVENT_BUDGET_MS - redirectSweepReserveMs() - (Date.now() - startedAt)) }); }
      catch (error) { console.log(JSON.stringify({ component: "broker", event: "agent_session.drain_failed", error: error instanceof Error ? error.name : "unknown" })); outcome.drain = "failed"; }
      // Stop & redirect: a redirect nobody finished is closed (nothing is read while the rd switch is off).
      try { outcome.redirects = await sweepRedirects(dependencies, process.env, redirectSweepBudgetMs(Date.now() - startedAt)); }
      catch (error) { console.log(JSON.stringify({ component: "broker", event: "redirect.sweep_failed", error: error instanceof Error ? error.name : "unknown" })); outcome.redirects = "failed"; }
      // System owner of automatic runs: a run past its time is ended and its slot given back, so a hung night can never hold the project's one automatic slot for good.
      outcome.automaticRuns = await sweepAutomaticRunsOf(dependencies, { budgetMs: Math.max(0, SESSION_EVENT_BUDGET_MS - (Date.now() - startedAt)) });
      outcome.asks = await runAskMaintenance(dependencies, Date.now());
      // Saved project images: the periodic poll (a few due projects a pass; off, nothing is read).
      // With the switch off the answer is today's, byte for byte: neither key is there.
      const polled = await runSavedEnvPoll(dependencies);
      if (polled !== "off") { outcome.savedEnv = polled; outcome.savedEnvBuilds = await sweepSavedEnvBuilds(dependencies); }
      return json(outcome, "session-sweep");
    }
    // Plan 3, Task 30: every 5 minutes, the spend settlement jobs (the sweep of open model keys today; PF13 adds the others to this list).
    if (isSpendSettlementEvent(event)) {
      const ledger = ledgerOf(dependencies);
      // PF13: one list of independent jobs inside one deadline of 27 seconds of the function's 30 (`settlementBudgets`). The short ones go first, each with its cap
      // or what remains of the deadline if that is less; the spend sweep, a resumable cursor, takes what is left after the audit's share, so a long sweep can't
      // starve the others and a late job can't push the later ones past the deadline. A job with no time left is skipped and reported so.
      const startedAt = Date.now();
      // Every third tick the learning job takes the key audit's share (a busy tick would otherwise never leave it a slice); spend settlement's budget is the same on every tick.
      const learningPriority = learningFirstTick(startedAt) ? { learningFirst: true } : {};
      const timed = (name: string, pick: keyof ReturnType<typeof settlementBudgets>, run: (budgetMs: number) => Promise<unknown>): SettlementJob =>
        timedSettlementJob({ name, pick, startedAt, now: Date.now, run, ...learningPriority });
      const sources = modelSourceSweepOf(dependencies);
      // Task 26: a backstop for the checks at the mint, where the install routes models at all.
      const keyAudit = routingOf(dependencies) === undefined ? undefined : dependencies.modelAccess?.access;
      const jobs: SettlementJob[] = [
        ...(agents === undefined ? [] : [timed("drain-member-merges", "drain", (budgetMs) => runMemberMergeDrain(removalDepsOf(agents, dependencies), { budgetMs }))]),
        // Task 21: approvals that expired, writes stuck after a claim, and handlers that never heard the outcome. A stuck write is driven again only while the
        // function has more than the connector's timeout and a margin left.
        ...(agents === undefined ? [] : [timed("expire-approvals", "approvals", (budgetMs) => runApprovalSweep(agents, { budgetMs, redriveUntil: redriveUntil(startedAt) }))]),
        // Task 32 (PF13): owners' spend requests nobody answered get the org's admins, and requests whose time ran out end; a small cap, before the sweeps.
        ...(agents === undefined ? [] : [timed("escalate-owner-requests", "escalate", (budgetMs) => escalateOwnerRequests(agents, { budgetMs }))]),
        // Task 24b: with a small budget of its own, before the spend sweep.
        ...(sources === undefined ? [] : [timed("sweep-model-sources", "sources", (budgetMs) => sweepModelSources(sources, { budgetMs }))]),
        ...(ledger === undefined ? [] : [timed("sweep-spend", "spend", (budgetMs) => runSpendSweep(ledger, { budgetMs }))]),
        // Last: it reads the proxy's keys over several calls and must not take time the sweeps need (Task 26).
        ...(keyAudit === undefined ? [] : [timed("audit-model-keys", "audit", (budgetMs) => auditModelKeys(keyAudit, budgetMs))]),
        // v1.2 learning loop: finishes the cleanup walks of closed companies and erased people. After every settlement job (spend settlement is a money job and is never delayed or starved by
        // it); it has its own 3 s slice and is skipped, with a log line, unless that and a safety margin are left. On every third tick it takes the key audit's share (`learningFirstTick`).
        timedSettlementJob({
          name: "resume-learning-walks", pick: "learning", startedAt, now: Date.now, ...learningPriority,
          onSkip: (name) => console.log(JSON.stringify({ component: "broker", event: "learning.settlement_job_skipped", job: name, reason: "not enough time left" })),
          run: async (budgetMs) => {
            const learning = await resumeOpenLearningWalks(learningWalkDeps({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, audit: dependencies.audit }), { millis: budgetMs }, (entry) => console.log(JSON.stringify({ component: "broker", ...entry })));
            // The evidence erases are finished by the broker's every-minute recovery run (S-3), on a budget of their own: this slice is the learning walk's.
            return { learning };
          },
        }),
      ];
      if (jobs.length === 0) return json({ skipped: true }, "spend-settlement");
      return json({ jobs: await runSettlementJobs(jobs, (entry) => console.log(JSON.stringify({ component: "broker", ...entry }))) }, "spend-settlement");
    }
    // Plan 4 Task 26: EventBridge Scheduler's own invocation for a schedule trigger. It is an asynchronous invoke: the scheduler is told only that Lambda accepted it, so a fault that may
    // pass is recorded in the chain dead-letter queue by `fireChainSchedule` and answered; it throws only where it cannot record.
    if (isChainScheduleEvent(event)) {
      const chainDependencies = chainRunnerDependenciesOf(dependencies, tasks, agents);
      if (chainDependencies?.triggerSchedules === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "schedules are not set up in this deployment");
      // The scheduler calls the broker asynchronously, so a throw would never reach its retry policy or the chain queue (review I-1): a fire that fails records itself in the chain queue.
      return json(await fireChainSchedule(chainDependencies, event, Date.now(), dependencies.agents?.scheduleDeadLetters), "chain-schedule");
    }
    // Test environment (wire-testenv): the scheduler's nightly fire for a project. Answers "off" and reads nothing where the switch is off; no run can be started yet, so it never charges a budget or claims a slot.
    if (isTestEnvNightlyEvent(event)) {
      // Saved project images: the project's images are checked before its night is started, and the deleted projects' registries are swept (never holds the night up).
      await savedEnvBeforeNightly(dependencies, event);
      return json(await fireTestEnvNightly({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }) }, event, nightlyRunsOf(dependencies, tasks, agents)), "test-env-nightly");
    }
    // Team record (wire-team-record): the scheduler's hourly and nightly jobs, and a Slack event the ingress verified and forwarded. Both answer "off" and do nothing where the record's switch is off.
    if (isTeamRecordJobEvent(event)) {
      try { return json(await runTeamRecordJob(dependencies, event), "team-record-job"); }
      catch (error) {
        console.log(JSON.stringify({ component: "broker", event: "team_record.job_failed", error: error instanceof Error ? error.name : "unknown" }));
        return json({ error: "job_failed" }, "team-record-job", 500);
      }
    }
    if (isTeamRecordSlackEvent(event)) {
      try { return json(await recordSlackForward(dependencies, event), "team-record-slack"); }
      catch (error) {
        console.log(JSON.stringify({ component: "broker", event: "team_record.slack_failed", error: error instanceof Error ? error.name : "unknown" }));
        // THROWN, not answered: a handler that returns is never run again. Lambda retries an asynchronous invoke that errors (twice); the ingress's request/response invoke sees the error.
        throw error;
      }
    }
    // Start from inside Slack (task 12): the ingress's private "Add to project" prompt and its Add press, for a verified Slack user. Answers "off" where the record is off.
    if (isTeamRecordSlackAddEvent(event)) {
      try { return json(await answerSlackAdd(dependencies, event), "team-record-slack-add"); }
      catch (error) { console.log(JSON.stringify({ component: "broker", event: "team_record.slack_add_failed", error: error instanceof Error ? error.name : "unknown" })); return json({ error: "unavailable" }, "team-record-slack-add", 500); }
    }
    // The record's durable queue (removals and edits that could not be applied at once): the partial-batch answer SQS reads, so only the messages that failed come back.
    if (isTeamRecordQueueEvent(event)) return await drainTeamRecordQueue(dependencies, event, context) as never;
    // A delete the broker sent to itself (TRW-5 S2): THROWN when it fails, so Lambda retries the asynchronous invoke and then hands it to the failure destination.
    if (isTeamRecordRemovalEvent(event)) {
      try { return json(await applyTeamRecordRemoval(dependencies, event), "team-record-removal"); }
      catch (error) {
        console.log(JSON.stringify({ component: "broker", event: "team_record.removal_failed", error: error instanceof Error ? error.name : "unknown" }));
        throw error;
      }
    }
    // Meta repo lane F (F2): every minute, the intake sources that are due are read (each by its own interval and hourly cap); a source that fails is backed off and, after an hour, its maintainers are told.
    if (isIntakePollEvent(event)) {
      try {
        const poll = intakePollDependenciesFrom(dependencies, tasks, agents);
        return json(poll === undefined ? { skipped: true } : await runIntakePoll(poll), "intake-poll");
      } catch (error) {
        console.log(JSON.stringify({ component: "broker", event: "intake_poll.failed", error: error instanceof Error ? error.name : "unknown" }));
        return json({ error: "poll_failed" }, "intake-poll", 500);
      }
    }
    // Plan 4 Task 9: every 5 minutes, the chain runs that are due (a step or run that ran out of time, a callback or a decision the run did not hear, an ending left half done).
    if (isChainSweepEvent(event)) {
      try {
        const chainDependencies = chainRunnerDependenciesOf(dependencies, tasks, agents);
        if (chainDependencies === undefined) return json({ skipped: true }, "chain-sweep");
        const runs = await sweepChainRuns(chainDependencies, Date.now());
        // Plan 4 Task 26: the same sweep drains up to 10 schedule dead letters and repairs schedules still pending; its part never changes what the sweep of runs answers where schedules are not set up.
        const deadLetters = dependencies.agents?.scheduleDeadLetters;
        if (chainDependencies.triggerSchedules === undefined && deadLetters === undefined) return json(runs, "chain-sweep");
        const schedules = await sweepSchedules(chainDependencies, { ...(deadLetters === undefined ? {} : { deadLetters }), now: Date.now() }).catch((error: unknown) => {
          console.log(JSON.stringify({ component: "broker", event: "chain_sweep.schedules_failed", error: error instanceof Error ? error.name : "unknown" }));
          return { error: "schedule_sweep_failed" };
        });
        return json({ ...runs, schedules }, "chain-sweep");
      } catch (error) {
        console.log(JSON.stringify({ component: "broker", event: "chain_sweep.failed", error: error instanceof Error ? error.name : "unknown" }));
        return json({ error: "sweep_failed" }, "chain-sweep", 500);
      }
    }
    // Plan 2, Task 19: every 5 minutes, the legacy backfill (once) and then the cell's DNS allowlist follows the approved egress domains.
    if (isEgressDomainsSyncEvent(event)) {
      try {
        const outcome = await runEgressDomainsSync(egressDepsOf(dependencies));
        return json(outcome, "egress-domains-sync", outcome.ok ? 200 : 500);
      } catch (error) {
        console.log(JSON.stringify({ component: "broker", event: "egress.sync_run_failed", error: error instanceof Error ? error.name : "unknown" }));
        return json({ error: "egress_sync_failed" }, "egress-domains-sync", 500);
      }
    }
    if (isGithubWebhookRecoveryEvent(event)) {
      try { return json(await retryDueGithubWebhookEvents(dependencies), "github-webhook-recovery"); }
      catch (error) {
        console.log(JSON.stringify({ component: "broker", event: "github.webhook_recovery_failed", error: error instanceof Error ? error.name : "unknown" }));
        return json({ error: "recovery_failed" }, "github-webhook-recovery", 500);
      }
    }
    if (isWorkflowMergeRecoveryEvent(event)) {
      try {
        const sweepStartedAt = Date.now();
        // Proof and evidence (S-3): the evidence erases a company close, a project archive or a person erase left unfinished are finished here, from their cursors, FIRST and on a budget of their own so nothing else can
        // starve them; this run exists on every install (a private one has no settlement schedule). Not behind the proof switch; a fault only means the next minute tries again.
        const evidence = await resumeEvidence(dependencies, EVIDENCE_RESUME_BUDGET_MS).catch((error: unknown) => {
          console.log(JSON.stringify({ component: "broker", event: "evidence.erase_resume_failed", error: error instanceof Error ? error.name : "unknown" }));
          return { pending: 0, finished: 0 };
        });
        // TE-4: saved or held setup commands waiting on a check are settled here too, so a check that ended with no result callback (or never) is acted on and its sender told. Its own small budget; a fault only means the next minute tries again.
        const settingsProofs = await sweepSettingsProofs(developerRouteDependencies, { limit: 25, budgetMs: 5_000 }).catch(() => ({ settled: 0, left: 0 }));
        const result = await runDueWorkflowMergeRecovery({
          documentClient: dependencies.documentClient,
          tableName: dependencies.tableName,
          now: Date.now,
          reconcile: (taskId, budget) => reconcileWorkflowMergeRecoveryTask(dependencies, taskId, budget),
        });
        // The tracking pass (Rovara Code) runs after the merge pass with the time that is left, in its own partition, behind its own gate: neither starves the other.
        const tracking = await runDueWorkflowMergeTracking(trackingPassDependencies(dependencies), { budgetMs: Math.max(0, SWEEP_EVENT_BUDGET_MS - (Date.now() - sweepStartedAt)) }).catch((error: unknown) => {
          console.log(JSON.stringify({ component: "broker", event: "workflow.merge_tracking_failed", error: error instanceof Error ? error.name : "unknown" }));
          return { attempted: 0, reconciled: 0, deferred: 0 };
        });
        // Rows a review woke are passed now, not at the heartbeat gate's next opening (approval-to-ready latency).
        const woken = await runWokenTrackingPass(dependencies, Math.max(0, SWEEP_EVENT_BUDGET_MS - (Date.now() - sweepStartedAt)));
        // Company domain verification: the daily re-check, LAST and only from the time the other passes left (a lookup may run past its share by its own deadline, so it is started only with that much to spare).
        const domains = await runCompanyDomainRecheck({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, audit: dependencies.audit }, { remainingMs: SWEEP_EVENT_BUDGET_MS - (Date.now() - sweepStartedAt) }).catch((error: unknown) => {
          console.log(JSON.stringify({ component: "broker", event: "company_domain.recheck_run_failed", error: error instanceof Error ? error.name : "unknown" }));
          return { checked: 0, verified: 0, lost: 0, released: 0, skipped: 0 };
        });
        return json({ ...result, tracking, woken, evidence, domains, settingsProofs }, "workflow-merge-recovery");
      } catch (error) {
        console.log(JSON.stringify({ component: "broker", event: "workflow.merge_recovery_failed", error: error instanceof Error ? error.name : "unknown" }));
        return json({ error: "recovery_failed" }, "workflow-merge-recovery", 500);
      }
    }
    // Gap 6: the scheduled sweep that re-runs any workflow dispatch left behind after its result committed.
    if (isWorkflowDispatchRecoveryEvent(event)) {
      try {
        const dispatches = await retryDueWorkflowDispatches(dependencies);
        // The plan evidence rows ride the same schedule; their failure never hides the dispatches' result.
        const planEvidence = await startDuePlanEvidenceJobs(dependencies).catch((error: unknown) => {
          console.log(JSON.stringify({ component: "broker", event: "plan_evidence.sweep_failed", error: error instanceof Error ? error.name : "unknown" }));
          return { attempted: 0, started: 0 };
        });
        // Rovara Code milestones a handler was not told after their commit (or threw on) are told again; this too never hides the dispatches' result.
        const codeMilestones = await deliverDueCodeMilestones({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now }).catch((error: unknown) => {
          console.log(JSON.stringify({ component: "broker", event: "code_milestone.sweep_failed", error: error instanceof Error ? error.name : "unknown" }));
          return { attempted: 0 };
        });
        // Finished tasks whose release found the workspace busy, failed or never ran: their slot and workspace are given back.
        const releases = await releasePendingFinishedTasks(releaseDependenciesOf(dependencies, Date.now() + OUTCOME_SETTLE_PASS_MS))
          .catch((error: unknown) => {
            console.log(JSON.stringify({ component: "broker", event: "developer.finished_task_sweep_failed", error: error instanceof Error ? error.name : "unknown" }));
            return { attempted: 0, released: 0 };
          });
        // This schedule ticks at its own moment of the minute, so rows a review woke are passed at whichever of the two ticks comes first.
        const woken = await runWokenTrackingPass(dependencies, 12_000);
        return json({ ...dispatches, planEvidence, codeMilestones, releases, woken }, "workflow-dispatch-recovery");
      }
      catch (error) {
        console.log(JSON.stringify({ component: "broker", event: "workflow.dispatch_recovery_failed", error: error instanceof Error ? error.name : "unknown" }));
        return json({ error: "recovery_failed" }, "workflow-dispatch-recovery", 500);
      }
    }
    // Sign in with ChatGPT from Slack (#340): the ingress asks, as the Slack user's own developer.
    if (isSlackChatGptCommandEvent(event) || isSlackChatGptFinishEvent(event)) {
      try {
        return json(await answerSlackChatGpt({
          ...(dependencies.chatgpt === undefined ? {} : { chatgpt: dependencies.chatgpt }),
          ...(dependencies.developer?.slackTeamId === undefined ? {} : { slackTeamId: dependencies.developer.slackTeamId }),
          allow: async (userId: string, teamId: string) => { if (dependencies.editionPolicy?.features.sso === true) await requireSlackAllowedByEdition(dependencies, userId, await slackTeamOrg(dependencies, teamId)); },
        }, event), "slack-ingress");
      } catch (error) {
        if (error instanceof AgentXError) {
          return json({ error: { code: error.code, message: stripCode(error.message, error.code) } }, "slack-ingress", error.statusCode);
        }
        return unexpectedErrorAnswer(error, "slack-ingress");
      }
    }
    if (isSlackStopTaskEvent(event)) {
      try {
        return json(await stopSlackThreadTask(dependencies, event), "slack-ingress");
      } catch (error) {
        if (error instanceof AgentXError) {
          return json({ error: { code: error.code, message: stripCode(error.message, error.code) } }, "slack-ingress", error.statusCode);
        }
        return unexpectedErrorAnswer(error, "slack-ingress");
      }
    }
    // Decision cards (wire-proof): a card's button pressed in Slack. Answered with one fixed sentence for the interactivity Lambda to say privately; `enabled: false` while the cards switch is off.
    if (isSlackDecisionPressEvent(event)) {
      if (!decisionCardsEnabled() || dependencies.developer === undefined) return json({ enabled: false }, "slack-ingress");
      return json(await handleSlackDecisionPress(dependencies, { documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: dependencies.developer, now: Date.now, tasks, orgs: orgStoreOf(dependencies), ...routeEditionDependencies(dependencies), ...(agents === undefined ? {} : { agents }) }, event), "slack-ingress");
    }
    if (isSlackTaskAuthorizationEvent(event)) {
      try { return json(await authorizeSlackTaskAction(dependencies, tasks, event), "slack-ingress"); }
      catch (error) {
        if (error instanceof AgentXError) return json({ error: { code: error.code, message: stripCode(error.message, error.code) } }, "slack-ingress", error.statusCode);
        return unexpectedErrorAnswer(error, "slack-ingress");
      }
    }
    if (isSlackTaskPeopleConfirmEvent(event)) {
      try { return json(await confirmSlackTaskPeople(dependencies, tasks, event), "slack-ingress"); }
      catch (error) {
        if (error instanceof AgentXError) return json({ error: { code: error.code, message: stripCode(error.message, error.code) } }, "slack-ingress", error.statusCode);
        return unexpectedErrorAnswer(error, "slack-ingress");
      }
    }
    if (isSlackTaskPeopleReadEvent(event) || isSlackTaskPeopleChangeEvent(event) || isSlackTaskPeopleTakeOwnershipEvent(event)) {
      try { return json(await handleSlackTaskPeople(dependencies, tasks, event), "slack-ingress"); }
      catch (error) {
        if (error instanceof AgentXError) return json({ error: { code: error.code, message: stripCode(error.message, error.code) } }, "slack-ingress", error.statusCode);
        return unexpectedErrorAnswer(error, "slack-ingress");
      }
    }
    if (isSlackWorkflowStartEvent(event)) {
      try {
        const task = await startSlackWorkflow(dependencies, tasks, event);
        return json({ taskId: task.task.taskId }, "slack-ingress");
      } catch (error) {
        if (error instanceof AgentXError) return json({ error: { code: error.code, message: stripCode(error.message, error.code) } }, "slack-ingress", error.statusCode);
        return unexpectedErrorAnswer(error, "slack-ingress");
      }
    }
    // Task 19: every Slack press the interactivity hands over asynchronously; a refusal is told to the presser privately.
    const approval = { outOfDate: SLACK_APPROVAL_OUT_OF_DATE, awsRequestId: context?.awsRequestId };
    const button = { outOfDate: SLACK_BUTTON_OUT_OF_DATE, awsRequestId: context?.awsRequestId };
    if (isSlackWorkflowDecisionEvent(event)) return answerSlackWorkflowEvent(dependencies, event, "decision", () => decideSlackWorkflow(dependencies, tasks, event), approval);
    if (isSlackWorkflowRetryEvent(event)) return answerSlackWorkflowEvent(dependencies, event, "verification_retry", () => retrySlackWorkflowChecks(dependencies, tasks, event), button);
    if (isSlackWorkflowReviewRetryEvent(event)) return answerSlackWorkflowEvent(dependencies, event, "review_retry", () => retrySlackWorkflowReviews(dependencies, tasks, event), button);
    if (isSlackWorkflowPublishRetryEvent(event)) return answerSlackWorkflowEvent(dependencies, event, "publish_retry", () => retrySlackWorkflowPublication(dependencies, tasks, event), button);
    if (isSlackWorkflowKeepPullRequestsEvent(event)) return answerSlackWorkflowEvent(dependencies, event, "keep_pull_requests", () => keepSlackWorkflowPullRequests(dependencies, tasks, event), button);
    if (isSlackWorkflowRevisePlanEvent(event)) return answerSlackWorkflowEvent(dependencies, event, "revise_plan", () => reviseSlackWorkflowPlan(dependencies, tasks, event), button);
    if (isSlackWorkflowSendBackEvent(event)) return answerSlackWorkflowEvent(dependencies, event, "send_back", () => sendSlackWorkflowBack(dependencies, tasks, event), button);
    if (isSlackWorkflowResolveFindingsEvent(event)) return answerSlackWorkflowEvent(dependencies, event, "resolve_findings", () => resolveSlackWorkflowFindings(dependencies, tasks, event), button);
    if (isSlackWorkflowCloseEvent(event)) return answerSlackWorkflowEvent(dependencies, event, "close", () => closeSlackWorkflowTask(dependencies, tasks, event), button);
    if (isSlackWorkflowFeedbackFindingsDecisionEvent(event)) {
      return answerSlackWorkflowEvent(dependencies, event, "feedback_findings_decision", () => decideSlackWorkflowFeedbackFindings(dependencies, tasks, event), approval);
    }
    if (isSlackWorkflowFeedbackReviewRetryEvent(event)) {
      return answerSlackWorkflowEvent(dependencies, event, "feedback_review_retry", () => retrySlackWorkflowFeedbackReview(dependencies, tasks, event), button);
    }
    if (isSlackThreadNoteEvent(event)) {
      try {
        const result = await recordSlackThreadNote(dependencies, tasks, event);
        // Never the note's text: only who and where.
        console.log(JSON.stringify({ component: "broker", event: "slack.thread_note", taskId: event.taskId, eventId: event.eventId, outcome: result.outcome }));
        // Exactly the outcome: the ingress reads nothing else.
        return { statusCode: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(result) };
      } catch (error) {
        // Every expected refusal is a 200 outcome above, so anything thrown means the reply was not saved: a
        // server error, never the 400 an unexpected error otherwise gets, which the ingress would read as a refusal.
        return replyNotSavedAnswer(error, event);
      }
    }
    if (isSlackWorkflowFeedbackNoteEvent(event)) {
      try {
        return json(await captureSlackWorkflowFeedbackNote(dependencies, tasks, event), "slack-ingress");
      } catch (error) {
        if (error instanceof AgentXError) return json({ error: { code: error.code, message: stripCode(error.message, error.code) } }, "slack-ingress", error.statusCode);
        // The ingress reads a 4xx as a refusal; an unexpected failure must make Slack retry instead.
        return replyNotSavedAnswer(error, event);
      }
    }
    const request = adaptHttpApiEvent(event);
    try {
      // Checked on the raw path, before URL parsing normalizes it: /v1/dev/../v1/admin/x reaches
      // the broker through the authorizer-free /v1/dev route (D17), so it must never be resolved.
      if (DOT_SEGMENT.test(event.rawPath ?? "/")) throw agentXError("NOT_FOUND", "route not found");
      const url = new URL(request.path, "https://agentx.invalid");
      // Shared links belong exclusively to the web shell, including stale broker route events.
      if (url.pathname.startsWith("/s/")) throw agentXError("NOT_FOUND", "route not found");
      // The browser page uses its own opaque revocable session cookie and reauthorizes each
      // request. Only API Gateway's exact public review route may reach this branch.
      // The audit page (`/v1/app/audit/view`) is a browser page of the same kind: its own session cookie, no API Gateway authorizer.
      if (event.routeKey === FEEDBACK_REVIEW_ROUTE_KEY || isAuditViewPath(url.pathname)) {
        if (!(url.pathname.startsWith("/review/") || isAuditViewPath(url.pathname)) || !dependencies.developer) throw agentXError("NOT_FOUND", "route not found");
        // 0.5.7: on the API's own address these pages go to the custom domain, where their cookies and sign-in live.
        const moved = legacyHostRedirect({ issuer: dependencies.developer.issuer, previousIssuer: dependencies.developer.previousIssuer, method: request.method, headers: request.headers, path: request.path });
        if (moved !== undefined) return moved;
        return await routeDeveloperRequest({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer: dependencies.developer, now: Date.now, tasks, orgs: orgStoreOf(dependencies),
          ...(dependencies.modelAccess === undefined ? {} : { modelAccess: dependencies.modelAccess.access }),
          ...(dependencies.cloud === true ? { cloud: true } : {}),
          ...routeEditionDependencies(dependencies),
          ...(dependencies.chatgpt === undefined ? {} : { chatgpt: dependencies.chatgpt }),
          evidenceErase: evidenceEraseOf(dependencies),
          sessionDiffFiles: dependencies.githubPullRequests.listPullRequestFiles === undefined ? undefined : (url, number, options, scope) => dependencies.githubPullRequests.listPullRequestFiles!(url, number, options, githubScope(dependencies, scope.orgId)),
          ...repositoriesGateRoute(dependencies),
          ...(dependencies.auditLedger === undefined ? {} : { auditLedger: dependencies.auditLedger }),
          ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }),
          ...(agents?.agentSessions === undefined ? {} : { agentSessions: agents.agentSessions }),
          // The task page says to press Merge in Rovara when it may be pressed (Bug G); this page carries no agent routes, so it carries the merge view alone.
          ...(agents?.codeMerge === undefined ? {} : { codeMergeView: (task: DeveloperTaskRecord, items: MergeTrackingItem[], viewer: string) => mergeViewOf(agents, task, items, viewer) }),
          ...workflowApplicationRouteDependencies(dependencies) }, request, url) as { statusCode: number; headers: Record<string, string>; body: string };
      }
      // The /v1/dev route has no API Gateway authorizer, so what it carries goes to the developer API or nowhere.
      if (event.routeKey === DEVELOPER_ROUTE_KEY && !url.pathname.startsWith("/v1/dev/")) throw agentXError("NOT_FOUND", "route not found");
      if (event.routeKey === APP_ROUTE_KEY && !url.pathname.startsWith("/v1/app/")) throw agentXError("NOT_FOUND", "route not found");
      if (event.routeKey === WEB_ROUTE_KEY && !url.pathname.startsWith("/v1/web/")) throw agentXError("NOT_FOUND", "route not found");
      if (url.pathname.startsWith("/v1/web/") && (event.routeKey !== WEB_ROUTE_KEY || !webRouteAllowed(request.method, url.pathname))) throw agentXError("NOT_FOUND", "route not found");
      // Plan 2, Task 13: the GitHub install flow's callback and the confirm page's form post. No token here: see github-install-web.ts.
      if (isGithubInstallPath(url.pathname)) return await routeGithubInstall(githubConnectionOf(dependencies), request, url);
      // Plan 3, Task 21a-presence: the confirmation page. A browser's decide cookie, CSRF field and Origin authorize it, never a bearer token.
      if (isDecidePagePath(url.pathname)) return await routeDecidePage(decideRequestContext(dependencies, agents), request, url);
      // Plan 4 Task 19: the endpoint vendors post events to. No token: every delivery proves itself over its own bytes (see triggers/ingress.ts).
      const hookPath = event.routeKey === HOOK_ROUTE_KEY ? HOOK_DELIVERY_PATH.exec(url.pathname) : null;
      if (hookPath !== null) {
        if (request.method !== "POST") return json({ error: { code: "NOT_FOUND", message: "route not found" } }, request.requestId, 404);
        const eventHooks = dependencies.agents?.eventHooks;
        // What starts the work is Task 20's dispatch over the chain runner's dependencies, unless the broker was given another. Where there is none (agents, chains or sign-in are not
        // set up) nothing a vendor sent would be acted on, so it is told to try later.
        const dispatch = eventDispatchOf(dependencies, tasks, agents);
        if (eventHooks === undefined || dispatch === undefined) return hookReply({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "try again" } } });
        // The bytes as they arrived: a signature is over these, not over text decoded from them.
        const raw = event.body === undefined ? Buffer.alloc(0) : Buffer.from(event.body, event.isBase64Encoded === true ? "base64" : "utf8");
        const answer = await receiveHook({
          documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now,
          hooks: new HookStore({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now }),
          secrets: eventHooks.secrets, providers: eventHooks.providers ?? hookProviders(), dispatch, memory: hookMemoryOf(dependencies),
          ...optional("awsAccounts", connectedAwsAccountsOf(dependencies)), ...optional("snsFetch", eventHooks.snsFetch),
          // Live interaction L1: a Linear comment on a bound issue may be an Ask; none while the Ask switch is off or Rovara cannot write in Linear.
          ...optional("commentIntake", linearCommentIntakeOf(dependencies)),
          // Team record: Linear and Jira deliveries reach the record after the hook's own checks (none while the switch is off).
          ...optional("recordTap", dependencies.teamRecord?.taps.hook),
        }, { source: hookPath[1]!, hookId: hookPath[2]!, raw, headers: request.headers, sourceIp: event.requestContext?.http?.sourceIp });
        return hookReply(answer);
      }
      if (url.pathname === "/v1/github/webhooks") {
        if (request.method !== "POST") return json({ error: { code: "NOT_FOUND", message: "route not found" } }, request.requestId, 404);
        if (request.body === undefined || dependencies.githubWebhookSecret === undefined) {
          return json({ error: { code: "RUNTIME_UNAVAILABLE", message: "GitHub webhook handling is not configured" } }, request.requestId, 503);
        }
        const notConfigured = () => json({ error: { code: "RUNTIME_UNAVAILABLE", message: "GitHub webhook handling is not configured" } }, request.requestId, 503);
        const readWebhookSecret = async (refresh: boolean): Promise<string | undefined> => {
          try {
            return await dependencies.githubWebhookSecret?.(refresh ? { refresh: true } : undefined);
          } catch (error) {
            if (isWebhookSecretMissing(error)) return undefined;
            throw error;
          }
        };
        const triggerDispatch = eventDispatchOf(dependencies, tasks, agents);
        try {
          const secret = await readWebhookSecret(false);
          if (secret === undefined) return notConfigured();
          const deliver = (webhookSecret: string) => handleGithubWebhook({
            documentClient: dependencies.documentClient,
            tableName: dependencies.tableName,
            rawBody: request.body ?? "",
            headers: request.headers,
            secret: webhookSecret,
            authorizeRepository: (scope) => "headSha" in scope
              ? resolveHeadEventTask(headEventDependencies(dependencies), scope).then((followed) => followed !== undefined)
              : authorizeLinkedGithubWebhook({
              documentClient: dependencies.documentClient,
              tableName: dependencies.tableName,
              scope,
              loadTask: (taskId) => getItem<DeveloperTaskRecord>(dependencies, taskKey(taskId)),
              repositoryUrl: webhookRepositoryUrl(dependencies),
              verifyRepository: (repositoryUrl, webhookScope) => dependencies.githubPullRequests.verifyWebhookRepository(repositoryUrl, webhookScope),
            }),
            process: (workflowEvent, deliveryId) => processGithubWorkflowEvent(dependencies, workflowEvent, deliveryId),
            // Team record: every verified delivery is offered to the record (none while the switch is off).
            ...optional("recordTap", dependencies.teamRecord?.taps.github),
            // Plan 4 Task 21: pull request, issue, deployment and workflow events start triggers' work, through the signature check above and Task 20's dispatch.
            ...(triggerDispatch === undefined ? {} : {
              triggerEvents: (trigger: { eventName: string; payload: unknown; installationId: number }) => deliverGithubTriggerEvents({
                documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, dispatch: triggerDispatch,
                ...(dependencies.githubPullRequests.appSlug === undefined ? {} : { githubAppSlug: () => dependencies.githubPullRequests.appSlug!() }),
                // A private org member shows as CONTRIBUTOR or NONE in a payload: the API is asked, with the installation's token, only when a members-only trigger would otherwise miss.
                ...(dependencies.githubPullRequests.authorStanding === undefined ? {} : {
                  authorStanding: (query: AuthorQuery) => dependencies.githubPullRequests.authorStanding!(query.installationId, query),
                }),
                // Meta repo lane A: a push to a project's meta repository queues its config file as a pending change.
                queueMetaConfigImport: metaConfigQueueFor(dependencies),
                // Saved project images: a push to a project's default branch tells the registry (only while `sv` is on and the registry is installed).
                ...optional("queueSavedEnvPush", savedEnvPushQueue(dependencies) === undefined ? undefined : (push: { orgId: OrgId; project: string }) => savedEnvPushQueue(dependencies)!(push)),
              }, trigger),
            }),
            // Plan 2, Task 14: an approved request to a GitHub admin arrives as `installation.created` naming the requester.
            installationCreated: async (deliveryId, payload) => {
              const connection = githubConnectionOf(dependencies);
              return connection === undefined ? "ignored" : bindRequestedInstallation(connection, deliveryId, payload);
            },
            // Plan 2, Task 15: GitHub's own changes to an installation an org bound (uninstalled, suspended, repositories changed).
            ...(dependencies.cloud === true ? {
              installationLifecycle: (deliveryId: string, event: InstallationLifecycleEvent) => applyInstallationLifecycle({
                documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now,
                log: (entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry })),
                ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }),
              }, deliveryId, event),
            } : {}),
            now: () => new Date().toISOString(),
          });
          let result;
          try {
            result = await deliver(secret);
          } catch (error) {
            if (!(error instanceof GithubWebhookRefusal) || error.message !== GITHUB_WEBHOOK_SIGNATURE_INVALID) throw error;
            // The secret may have been changed since this container read it. The signature is checked before a delivery is
            // reserved, so verifying once more with a fresh copy has no side effect.
            const renewed = await readWebhookSecret(true);
            if (renewed === undefined) return notConfigured();
            if (renewed === secret) throw error;
            result = await deliver(renewed);
          }
          if (result.status === "IN_PROGRESS") return json({ delivery: result.status, deliveryId: result.deliveryId }, request.requestId, 503);
          // An installation lifecycle delivery is accepted for processing, whatever it changed (or ignored); so is an event that went to triggers, or that nothing used.
          return json({ delivery: result.status, deliveryId: result.deliveryId }, request.requestId, result.lifecycle === true || result.trigger === true || result.status === "IGNORED" ? 202 : 200);
        } catch (error) {
          if (error instanceof GithubWebhookRefusal) return json({ error: { code: "FORBIDDEN", message: error.message } }, request.requestId, 403);
          if (error instanceof GithubWebhookRetryableError) return json({ error: { code: "RUNTIME_UNAVAILABLE", message: "GitHub webhook processing will be retried" } }, request.requestId, 503);
          if (error instanceof AgentXError && error.code === "RUNTIME_UNAVAILABLE") return json({ error: { code: error.code, message: "GitHub webhook processing will be retried" } }, request.requestId, 503);
          throw error;
        }
      }
      // Spec 043: an eval runner's callbacks, authorized by the run's own capability.
      const evalCallback = isSwebenchCallbackPath(url.pathname);
      if (request.method === "POST" && evalCallback !== undefined) {
        return json(await handleSwebenchCallback(swebenchDependencies(dependencies), request.headers["x-agentx-callback-capability"], evalCallback.runId, evalCallback.action, parseBody(request.body)), request.requestId);
      }
      const setupCallback = /^\/v1\/internal\/project-setups\/([0-9a-f-]{36})\/operations\/([0-9a-f-]{36})\/result$/.exec(url.pathname);
      if (request.method === "POST" && setupCallback?.[1] && setupCallback[2]) {
        return json(await handleProjectSetupCallback(dependencies, request, setupCallback[1], setupCallback[2]), request.requestId);
      }
      const setupArtifact = /^\/v1\/internal\/project-setups\/([0-9a-f-]{36})\/(execution|evidence(?:\/init|\/chunks|\/finalize)?)$/.exec(url.pathname);
      if (setupArtifact?.[1] && setupArtifact[2] === "execution" && request.method === "GET") {
        return json(await handleProjectSetupExecutionRead(dependencies, request, setupArtifact[1], url.searchParams.get("offset")), request.requestId);
      }
      if (setupArtifact?.[1] && setupArtifact[2] === "evidence/init" && request.method === "POST") {
        return json(await handleProjectSetupEvidenceInit(dependencies, request, setupArtifact[1]), request.requestId);
      }
      if (setupArtifact?.[1] && setupArtifact[2] === "evidence/chunks" && request.method === "POST") {
        return json(await handleProjectSetupEvidenceChunk(dependencies, request, setupArtifact[1]), request.requestId);
      }
      if (setupArtifact?.[1] && setupArtifact[2] === "evidence/finalize" && request.method === "POST") {
        return json(await handleProjectSetupEvidenceFinalize(dependencies, request, setupArtifact[1]), request.requestId);
      }
      // Internal worker routes authenticate with operation-scoped capabilities; user JWT auth starts below them.
      // Ruling R29: a task's model proxy key, authorized by the operation's capability, which names the task's operation.
      if (request.method === "GET" && url.pathname === "/v1/internal/model-access") return await handleModelAccess(dependencies, request);
      // DR7: a design-review reviewer's stored packet, authorized by the operation's own `design-review-packet` capability.
      if (request.method === "GET" && url.pathname === "/v1/internal/design-review/packet") return await handleDesignReviewPacket(dependencies, request);
      // Plan 3 Task 9: the pinned skills of the operation's task snapshot, authorized by the operation's `agent-skills` capability.
      if (request.method === "GET" && url.pathname === "/v1/internal/agent-skills") return await handleAgentSkills(dependencies, request);
      // Plan 3 Task 19: the connector tools an agent step is granted, and one call of them; authorized by the operation's `agent-tools` capability.
      if (request.method === "GET" && url.pathname === "/v1/internal/agent-tools") return json(await handleAgentTools(dependencies, agents, request, "list"), request.requestId);
      if (request.method === "POST" && url.pathname === "/v1/internal/agent-tools/call") return json(await handleAgentTools(dependencies, agents, request, "call"), request.requestId);
      // Team record: the record tools of a step (none while the record's switch is off). Both are POST, so the POST-only internal route covers them and no API route is added.
      if (request.method === "POST" && url.pathname === "/v1/internal/record-tools/list") return json(await handleAgentTools(dependencies, agents, request, "record-list"), request.requestId);
      if (request.method === "POST" && url.pathname === "/v1/internal/record-tools/call") return json(await handleAgentTools(dependencies, agents, request, "record-call"), request.requestId);
      // Lane E: the project's MCP context sources, for an Understand, Plan, Plan-check or Review stage; authorized by the operation's `context-tools` capability.
      if (request.method === "GET" && url.pathname === "/v1/internal/context-tools") return json(await handleContextTools(dependencies, request, "list"), request.requestId);
      if (request.method === "POST" && url.pathname === "/v1/internal/context-tools/call") return json(await handleContextTools(dependencies, request, "call"), request.requestId);
      // Saved project images: the push login and result are callback actions only where the registry is installed; elsewhere those paths are not found, as any unknown path.
      const savedEnvOn = dependencies.savedEnvDeps !== undefined && savedEnvEnabled();
      const callback = new RegExp(`^\\/v1\\/internal\\/workspaces\\/([0-9a-f-]+)\\/operations\\/([0-9a-f-]+)\\/(events|artifacts|result|candidate-export|candidate-build-source|baseline-source|e2e-admission|e2e-evidence|e2e-model-budget|feedback-bundles|feedback-approval|pull-request|pull-request-update|codebuild|chatgpt-token|chatgpt-status|model-fallback|setup-agent|nightly-result|fixture-set${savedEnvOn ? "|saved-env-push-login|saved-env-result" : ""})$`).exec(
        url.pathname,
      );
      if (request.method === "POST" && callback?.[1] && callback[2] && callback[3]) {
        return await handleCallback(dependencies, request, callback[1], callback[2], callback[3]);
      }
      // N9 (INTG2): a project's registry token, given to a running preparation only (project-registries/exchange.ts).
      const registryExchange = /^\/v1\/internal\/workspaces\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)\/registry-credentials$/.exec(url.pathname);
      if (request.method === "POST" && registryExchange?.[1] && registryExchange[2]) {
        return json(await exchangeRegistryCredential(dependencies, request, registryExchange[1], registryExchange[2]), request.requestId);
      }
      // Saved environments (SH25): the pull login, given to a running preparation for the image it was told to pull (test-env/saved-env-login.ts).
      const savedEnvLoginExchange = /^\/v1\/internal\/workspaces\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)\/saved-env-login$/.exec(url.pathname);
      if (request.method === "POST" && savedEnvLoginExchange?.[1] && savedEnvLoginExchange[2]) {
        return json(await exchangeSavedEnvLogin(dependencies, request, savedEnvLoginExchange[1], savedEnvLoginExchange[2]), request.requestId);
      }
      // Saved project images: the rebuild job's push login and result (answered to the job's lease), and a preparation's fallback report (test-env/saved-env-lease.ts).
      const savedEnvFallback = savedEnvOn ? /^\/v1\/internal\/workspaces\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)\/saved-env-fallback$/.exec(url.pathname) : null;
      if (request.method === "POST" && savedEnvFallback?.[1] && savedEnvFallback[2]) {
        return json(await handleSavedEnvFallback(dependencies, request, savedEnvFallback[1], savedEnvFallback[2]), request.requestId);
      }
      const credentialExchange = /^\/v1\/internal\/workspaces\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)\/repository-credentials$/.exec(
        url.pathname,
      );
      if (request.method === "POST" && credentialExchange?.[1] && credentialExchange[2]) {
        return json(
          {
            credential: await exchangeRepositoryCredential(
              dependencies,
              request,
              credentialExchange[1],
              credentialExchange[2],
            ),
          },
          request.requestId,
        );
      }

      // The hosted Slack orchestrator authenticates with its IAM role and acts only as a Slack thread owner.
      if (url.pathname.startsWith("/v1/service/")) {
        const serviceUrl = new URL(`/v1${url.pathname.slice("/v1/service".length)}${url.search}`, "https://agentx.invalid");
        // Spec 052 Task 6: the batch watcher's list is the whole Slack service's, not one thread's.
        if (request.method === "GET" && serviceUrl.pathname === "/v1/evals/batches/active") {
          requireSlackServiceRole(dependencies, request);
          if (dependencies.swebench === undefined) return json({ batches: [], dropped: [] }, request.requestId);
          return json(await listWatchedBatches(swebenchDependencies(dependencies), async (teamId, channelId) => (await getTeamSlackBinding(dependencies, teamId, channelId))?.projectName), request.requestId);
        }
        // Task 13: a turn's model key. It needs the thread's team and channel, not the thread's own identity, so it is answered before it.
        if (request.method === "POST" && serviceUrl.pathname === "/v1/model-access") {
          return await handleSlackModelAccess(dependencies, request);
        }
        // Live interaction A3: the Ask routes name the Ask itself (no Slack thread), so they are answered before the thread's identity is read.
        const askAnswer = await handleAskServiceRoute(dependencies, dependencies.slackAsk?.ask, request, serviceUrl.pathname);
        if (askAnswer !== undefined) return askAnswer;
        // Live interaction F2: the diagnosis routes name the diagnosis itself, like the Ask routes.
        const diagnosisAnswer = await handleDiagnosisServiceRoute(dependencies, dependencies.diagnosisService, request, serviceUrl.pathname);
        if (diagnosisAnswer !== undefined) return diagnosisAnswer;
        const identity = await slackServiceIdentity(dependencies, request);
        if (request.method === "POST" && serviceUrl.pathname === "/v1/threads/workspace") {
          return json(await ensureThreadWorkspace(dependencies, identity, parseBody(request.body)), request.requestId);
        }
        if (request.method === "POST" && serviceUrl.pathname === "/v1/tasks/thread-notes/answered") {
          return json(await markThreadNoteAnswered(dependencies, identity, parseBody(request.body)), request.requestId);
        }
        if (request.method === "POST" && serviceUrl.pathname === "/v1/tasks/comments/answered") {
          return json(await markCommentAnswered(dependencies, identity, parseBody(request.body)), request.requestId);
        }
        if (request.method === "POST" && serviceUrl.pathname === "/v1/threads/workspace/prepare") {
          return json(await prepareThreadWorkspace(dependencies, identity, parseBody(request.body)), request.requestId);
        }
        if (request.method === "POST" && serviceUrl.pathname === "/v1/threads/workspace/close") {
          return json(await startThreadWorkspaceClose(dependencies, identity, parseBody(request.body)), request.requestId, 202);
        }
        if (request.method === "POST" && serviceUrl.pathname === "/v1/threads/workspace/close/complete") {
          return json(await completeThreadWorkspaceClose(dependencies, identity, parseBody(request.body)), request.requestId);
        }
        if (request.method === "GET" && serviceUrl.pathname === "/v1/project/models") {
          return json(await getProjectModels(dependencies, identity), request.requestId);
        }
        if (request.method === "PUT" && serviceUrl.pathname === "/v1/project/model") {
          return json(await putProjectModel(dependencies, identity, parseBody(request.body), request.requestId), request.requestId);
        }
        if (request.method === "POST" && serviceUrl.pathname === "/v1/evals/swebench") {
          await requireSlackRequesterMayWork(dependencies, identity, identity.slack?.binding.projectName ?? "");
          return json(await startSwebenchRun(swebenchDependencies(dependencies), swebenchSlackContext(dependencies, identity), parseBody(request.body)), request.requestId);
        }
        // Spec 052 FR-002 and Task 6: the Slack batch form, and the watcher's thread and posts for one batch.
        if (request.method === "POST" && serviceUrl.pathname === "/v1/evals/batches") {
          await requireSlackRequesterMayWork(dependencies, identity, identity.slack?.binding.projectName ?? "");
          return json(await startSlackBatch(swebenchDependencies(dependencies), swebenchSlackContext(dependencies, identity), parseBody(request.body)), request.requestId);
        }
        const watchedBatch = /^\/v1\/evals\/batches\/([0-9a-f-]{36})\/(thread|watch|drop)$/.exec(serviceUrl.pathname);
        if (request.method === "POST" && watchedBatch?.[1] && watchedBatch[2]) {
          const slack = identity.slack;
          if (!slack) throw agentXError("FORBIDDEN", "Slack thread context is required");
          const scope = { thread: slack.thread, projectName: slack.binding.projectName };
          const swebench = swebenchDependencies(dependencies);
          const body = parseBody(request.body);
          const answer = watchedBatch[2] === "thread" ? await recordWatchedBatchThread(swebench, scope, watchedBatch[1], body)
            : watchedBatch[2] === "drop" ? await dropWatchedBatch(swebench, scope, watchedBatch[1], body)
            : await updateWatchedBatch(swebench, scope, watchedBatch[1], body);
          return json(answer, request.requestId);
        }
        const evalRun = /^\/v1\/evals\/swebench\/([0-9a-f-]{36})$/.exec(serviceUrl.pathname);
        if (request.method === "GET" && evalRun?.[1]) {
          const thread = identity.slack?.thread;
          if (!thread) throw agentXError("FORBIDDEN", "Slack thread context is required");
          return json({ run: await getSwebenchRunForThread(swebenchDependencies(dependencies), thread, evalRun[1]) }, request.requestId);
        }
        return await observeConnectorRoute(request.method, serviceUrl.pathname, () => routeWorkspaceRequest(dependencies, request, serviceUrl, identity));
      }

      // Spec 025: the developer API. /v1/dev/* has no API Gateway authorizer (D17): the broker
      // verifies the developer token, then checks the method and session (FR-009).
      if (url.pathname.startsWith("/v1/dev/") || url.pathname.startsWith("/v1/app/") || url.pathname.startsWith("/v1/web/")) {
        if (!dependencies.developer) throw agentXError("NOT_FOUND", "developer sign-in is not set up in this deployment");
        const routeDependencies = developerRouteDependencies()!;
        let authenticated: { caller: DeveloperCaller; csrf: string } | undefined;
        if (url.pathname.startsWith("/v1/web/")) {
          const caller = await authenticateWebRequest(routeDependencies, request);
          authenticated = { caller, csrf: appCsrfTokenFor(caller.sessionId) };
          url.pathname = "/v1/app/" + url.pathname.slice("/v1/web/".length);
        }
        const answer = await routeDeveloperRequest(routeDependencies, request, url, authenticated);
        return developerReply(answer, request.requestId);
      }

      // Enterprise foundations E3: everything from here is the admin pool's; Rovara staff routes are off in the Enterprise edition (a closed list of operator routes is served).
      requireStaffRouteAllowed(dependencies.editionPolicy, url.pathname);
      const claimed = identityFromJwtClaims(request.jwtClaims, {
        issuer: dependencies.issuer,
        adminClaim: dependencies.adminClaim,
        adminValues: dependencies.adminValues,
      });
      // Ruling R1: the org comes from the injected resolver; a caller with none (ruling R6) is refused by each org-scoped route.
      const callerOrgId = await orgResolverOf(dependencies)({ ownerKey: claimed.ownerKey });
      const identity: AuthenticatedIdentity = callerOrgId === undefined ? claimed : { ...claimed, orgId: callerOrgId };
      const webhookRetry = /^\/v1\/admin\/github\/webhook-deliveries\/([0-9a-f-]{36})\/retry$/.exec(url.pathname);
      if (request.method === "POST" && webhookRetry?.[1]) {
        return json(await retryGithubWebhookAsAdministrator(dependencies, identity, webhookRetry[1]), request.requestId, 202);
      }
      const projectSetupRetry = /^\/v1\/admin\/projects\/setup-executions\/([0-9a-f-]{36})\/retry$/.exec(url.pathname);
      if (request.method === "POST" && projectSetupRetry?.[1]) {
        return json(await retryProjectSetupAsAdministrator(dependencies, identity, projectSetupRetry[1], parseBody(request.body)), request.requestId, 202);
      }
      const body = parseBody(request.body);
      // Spec 025 phase 25e: admin changes (FR-039 to FR-041, FR-052).
      const changed = await routeAdminChange(adminChanges, identity, { method: request.method, headers: request.headers, body }, url);
      if (changed !== undefined) return json(changed.body, request.requestId, changed.status);
      // Spec 025 phase 25d: the admin read routes (FR-038), each behind the admin claim (A2).
      const adminRead = await routeAdminRead(adminReads, identity, request, url);
      if (adminRead !== undefined) return json(adminRead, request.requestId);
      // Task 12: Rovara staff reading an org's audit log. Fail-closed: the staff read is recorded before anything is read.
      const staffAudit = await routeAuditAdminRequest(
        {
          ledger: dependencies.auditLedger,
          orgExists: async (orgId) => (await orgStoreOf(dependencies).getOrg(orgId)) !== undefined,
          ...(dependencies.auditErase === undefined ? {} : { erase: dependencies.auditErase }),
          personName: (developerId) => developerDisplayName(dependencies, developerId),
        },
        identity, { method: request.method, body, requestId: request.requestId }, url);
      if (staffAudit !== undefined) return json(staffAudit.body, request.requestId, staffAudit.status);

      if (request.method === "POST" && url.pathname === "/v1/admin/runtime-installation/challenges") {
        if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
        if (!dependencies.projectSetupRuntimeCatalogId || !dependencies.e2eFeatureRuntimeCatalogId) throw agentXError("RUNTIME_UNAVAILABLE", "runtime installation catalogs are not configured in this deployment");
        const runtimeDeps: RuntimeInstallationDependencies = { documentClient: dependencies.documentClient, s3: dependencies.s3,
          tableName: dependencies.tableName, artifactBucketName: dependencies.artifactBucketName,
          setupCatalogId: dependencies.projectSetupRuntimeCatalogId, featureCatalogId: dependencies.e2eFeatureRuntimeCatalogId };
        return json(await issueRuntimeInstallChallenge(runtimeDeps, identity, body), request.requestId, 201);
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/runtime-installation/registrations") {
        if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
        if (!dependencies.projectSetupRuntimeCatalogId || !dependencies.e2eFeatureRuntimeCatalogId) throw agentXError("RUNTIME_UNAVAILABLE", "runtime installation catalogs are not configured in this deployment");
        const runtimeDeps: RuntimeInstallationDependencies = { documentClient: dependencies.documentClient, s3: dependencies.s3,
          tableName: dependencies.tableName, artifactBucketName: dependencies.artifactBucketName,
          setupCatalogId: dependencies.projectSetupRuntimeCatalogId, featureCatalogId: dependencies.e2eFeatureRuntimeCatalogId };
        return json(await registerRuntimeInstallation(runtimeDeps, identity, body), request.requestId, 201);
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/projects/setup-proposals") {
        if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
        await requirePricedTaskStopAdmission(dependencies, { orgId: identity.orgId, actor: { kind: "operator", id: auditOperatorId(identity.issuer, identity.subject) }, workKind: "admin-setup-proposals" });
        if (!dependencies.projectSetupSource) throw agentXError("RUNTIME_UNAVAILABLE", "trusted project source capture is not configured");
        const requestBody = z.object({ repositoryUrl: z.string().url().max(500), ref: z.string().min(1).max(255) }).strict().parse(body);
        const urlParts = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(requestBody.repositoryUrl);
        if (!urlParts?.[1] || !urlParts[2]) throw agentXError("CONFIG_INVALID", "setup repository must be a canonical GitHub repository URL");
        const snapshot = await dependencies.projectSetupSource.capture({ repositoryUrl: requestBody.repositoryUrl, ref: requestBody.ref }, githubScope(dependencies, identity.orgId));
        const candidate = snapshot.candidate;
        const sourceRepository = candidate.repositories.length === 1 ? candidate.repositories[0] : undefined;
        const expectedRepositoryId = `${urlParts[1]}/${urlParts[2]}`;
        if (!sourceRepository || sourceRepository.repositoryId.toLowerCase() !== expectedRepositoryId.toLowerCase()) throw agentXError("FORBIDDEN", "captured source repository does not match the selected repository");
        verifyE2ESourceSnapshot(snapshot, candidate);
        const inspection = inspectE2ERepository(snapshot, candidate).inspection;
        // Web and API targets are proposed against the qualified runtime profile when this installation has one READY (Ruling Y4: one row per kind).
        const readyProfiles = dependencies.e2eFeatureRuntimeCatalogId === undefined ? []
          : await readReadyE2ERuntimeProfiles({ runtimeCatalogId: dependencies.e2eFeatureRuntimeCatalogId, profileId: WEB_API_RUNTIME_PROFILE_ID, now: Date.now(),
            read: (key) => getItem<Record<string, unknown>>(dependencies, key) });
        const proposal = proposeE2ESetup({ inspection, snapshot, expectedCandidate: candidate, readyProfiles });
        const agentRoute = await plannedAgentRoute(dependencies);
        const policy = projectSetupPolicy(proposal, agentRoute);
        const aiNavigation = agentRoute === undefined ? null : agentRouteSummary(agentRoute.definition, { drivingTest: agentRoute.drivingTest });
        const aiNavigationUntested = agentRoute === undefined ? await untestedAgentRouteNote(dependencies) : null;
        const repositoryName = urlParts[2].replace(/\.git$/i, "");
        const cleanedRepositoryName = repositoryName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
        const registeredRepositoryId = /^[a-z]/.test(cleanedRepositoryName) ? cleanedRepositoryName : `repo-${cleanedRepositoryName}`.slice(0, 63);
        const artifact = {
          schemaVersion: "project-setup-source-proposal/v1",
          issuerOwnerKey: identity.ownerKey,
          repositoryUrl: requestBody.repositoryUrl,
          selectedRef: requestBody.ref,
          identityMapping: { schemaVersion: "github-source-to-agentx-registration/v1", sourceRepositoryId: expectedRepositoryId, registeredRepositoryId },
          candidate,
          snapshot: { ...snapshot, sources: snapshot.sources.map(source => ({ ...source, bytesBase64: Buffer.from(source.bytes).toString("base64"), bytes: undefined })) },
          proposal,
          policy,
          ...(aiNavigation === null ? {} : { aiNavigation }),
        };
        const artifactBytes = canonicalJson(artifact);
        if (Buffer.byteLength(artifactBytes, "utf8") > MAX_SETUP_PROPOSAL_BYTES) throw agentXError("RUNTIME_UNAVAILABLE", "immutable setup proposal exceeds its bounded object size");
        const artifactDigest = createHash("sha256").update(artifactBytes, "utf8").digest("hex");
        const proposalRef = `project-setup-proposals/${identity.ownerKey}/${artifactDigest}.json`;
        try {
          await dependencies.s3.send(new PutObjectCommand({
            Bucket: dependencies.artifactBucketName,
            Key: proposalRef,
            Body: artifactBytes,
            ContentType: "application/json",
            Metadata: { sha256: artifactDigest, owner: identity.ownerKey, candidate: candidate.digest },
            IfNoneMatch: "*",
          }));
        } catch (error) {
          const code = error && typeof error === "object" ? (error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } }).name : undefined;
          const status = error && typeof error === "object" ? (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode : undefined;
          if (code !== "PreconditionFailed" && status !== 412) throw error;
          const retained = await readStoredText(dependencies.s3, dependencies.artifactBucketName, proposalRef, MAX_SETUP_PROPOSAL_BYTES);
          if (retained !== artifactBytes) throw agentXError("RUNTIME_UNAVAILABLE", "content-addressed setup proposal object conflicts with its expected bytes");
        }
        return json({ proposalRef, proposalSha256: artifactDigest, candidateDigest: candidate.digest, commitSha: snapshot.commitSha, treeSha: snapshot.treeSha, proposal, policy, aiNavigation, aiNavigationUntested }, request.requestId);
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/projects/setup-approvals") {
        if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
        if ((body as { decision?: unknown } | null)?.decision !== "decline") await requirePricedTaskStopAdmission(dependencies, { orgId: identity.orgId, actor: { kind: "operator", id: auditOperatorId(identity.issuer, identity.subject) }, workKind: "admin-setup-approvals" });
        const approvalInput = z.object({ projectName: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), proposalRef: z.string().min(1).max(512), proposalSha256: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(["approve", "decline"]) }).strict().parse(body);
        const expectedPrefix = `project-setup-proposals/${identity.ownerKey}/`;
        if (!approvalInput.proposalRef.startsWith(expectedPrefix) || approvalInput.proposalRef !== `${expectedPrefix}${approvalInput.proposalSha256}.json`) throw agentXError("FORBIDDEN", "setup proposal reference is outside the authenticated administrator scope");
        const stored = await readStoredText(dependencies.s3, dependencies.artifactBucketName, approvalInput.proposalRef, MAX_SETUP_PROPOSAL_BYTES);
        if (!stored || createHash("sha256").update(stored, "utf8").digest("hex") !== approvalInput.proposalSha256) throw agentXError("RUNTIME_UNAVAILABLE", "stored setup proposal is missing or its digest changed");
        let artifact: Record<string, unknown>;
        try {
          const decoded: unknown = JSON.parse(stored);
          if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid");
          artifact = decoded as Record<string, unknown>;
        } catch { throw agentXError("RUNTIME_UNAVAILABLE", "stored setup proposal is unreadable"); }
        if (artifact.schemaVersion !== "project-setup-source-proposal/v1" || artifact.issuerOwnerKey !== identity.ownerKey) throw agentXError("FORBIDDEN", "stored setup proposal belongs to another administrator");
        const storedSnapshot = artifact.snapshot;
        if (!storedSnapshot || typeof storedSnapshot !== "object" || Array.isArray(storedSnapshot)) throw agentXError("RUNTIME_UNAVAILABLE", "stored setup source snapshot is missing");
        const snapshotObject = storedSnapshot as Record<string, unknown>;
        const rawSources = snapshotObject.sources;
        if (!Array.isArray(rawSources)) throw agentXError("RUNTIME_UNAVAILABLE", "stored setup source inventory is invalid");
        const sources = rawSources.map((raw) => {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw agentXError("RUNTIME_UNAVAILABLE", "stored setup source item is invalid");
          const source = raw as Record<string, unknown>;
          if (typeof source.path !== "string" || typeof source.sha256 !== "string" || typeof source.bytesBase64 !== "string" || source.kind !== "blob") throw agentXError("RUNTIME_UNAVAILABLE", "stored setup source item is invalid");
          return { path: source.path, sha256: source.sha256, bytes: Buffer.from(source.bytesBase64, "base64"), kind: "blob" as const };
        });
        const snapshot = { ...snapshotObject, sources } as unknown as E2ESourceSnapshot;
        const candidate = snapshot.candidate;
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw agentXError("RUNTIME_UNAVAILABLE", "stored setup candidate is invalid");
        verifyE2ESourceSnapshot(snapshot, candidate);
        const inspection = inspectE2ERepository(snapshot, candidate).inspection;
        const proposal = verifyE2ESetupProposal(E2ESetupProposalSchema.parse(artifact.proposal), snapshot, candidate);
        const agentRoute = await plannedAgentRoute(dependencies);
        const policy = projectSetupPolicy(proposal, agentRoute);
        if (!sameJsonContent(artifact.policy, policy)) {
          // A proposal made under an earlier default is not approvable now, but a decision already recorded for it is still answered the same way (an idempotent retry).
          const decided = await getItem<Record<string, unknown>>(dependencies, projectSetupApprovalKey(requireOrgId(identity.orgId), approvalInput.projectName, approvalInput.proposalSha256));
          if (decided) {
            if (decided.ownerKey !== identity.ownerKey || decided.decision !== approvalInput.decision) throw agentXError("PROJECT_REVISION_MISMATCH", "setup proposal already has a different immutable decision");
            return json({ proposalRef: approvalInput.proposalRef, proposalSha256: approvalInput.proposalSha256, decision: approvalInput.decision, duplicate: true }, request.requestId);
          }
          // The only difference is the AI navigation route: the installation's provider, model, secret or OpenRouter policy changed (or another approval moved the registry) since the proposal.
          if (sameJsonContent({ ...(artifact.policy as Record<string, unknown>), modelRouteRevision: null, limits: null }, { ...policy, modelRouteRevision: null, limits: null })) {
            // With no route now, the settings were not read or no longer give a usable route; they have not been shown to have changed.
            if (agentRoute === undefined) {
              const untested = await untestedAgentRouteNote(dependencies);
              throw agentXError("RUNTIME_UNAVAILABLE", `${E2E_AGENT_UNAVAILABLE_REASONS.routeNotApproved}: ${untested !== null ? `${untested.sentence}; run the driving test, then propose the setup again`
                : "The AI navigation settings of this installation could not be read, or no longer give a usable route; propose the setup again once they can be"}`);
            }
            throw agentXError("RUNTIME_UNAVAILABLE", `${E2E_MODEL_ROUTE_CHANGED_REAPPROVE}: The AI navigation settings changed; propose the setup again, then approve the new proposal`);
          }
          throw agentXError("RUNTIME_UNAVAILABLE", "this setup proposal was made under an earlier default policy and can no longer be approved: propose the setup again (re-propose the setup), then approve the new proposal");
        }
        const identityMapping = artifact.identityMapping;
        if (!identityMapping || typeof identityMapping !== "object" || Array.isArray(identityMapping)
          || (identityMapping as Record<string, unknown>).schemaVersion !== "github-source-to-agentx-registration/v1"
          || (identityMapping as Record<string, unknown>).sourceRepositoryId !== candidate.repositories[0]?.repositoryId
          || typeof (identityMapping as Record<string, unknown>).registeredRepositoryId !== "string") throw agentXError("RUNTIME_UNAVAILABLE", "stored setup repository identity mapping is invalid");
        const canonicalArtifact = { ...artifact, snapshot: { ...snapshotObject, sources: sources.map(source => ({ path: source.path, sha256: source.sha256, kind: source.kind, bytesBase64: source.bytes.toString("base64") })) }, proposal };
        if (canonicalJson(canonicalArtifact) !== stored || proposeE2ESetup({ inspection, snapshot, expectedCandidate: candidate }).candidateDigest !== proposal.candidateDigest) throw agentXError("RUNTIME_UNAVAILABLE", "stored setup proposal does not match its source-derived bytes");
        const approvalKey = projectSetupApprovalKey(requireOrgId(identity.orgId), approvalInput.projectName, approvalInput.proposalSha256);
        const existing = await getItem<Record<string, unknown>>(dependencies, approvalKey);
        if (existing) {
          if (existing.ownerKey !== identity.ownerKey || existing.decision !== approvalInput.decision) throw agentXError("PROJECT_REVISION_MISMATCH", "setup proposal already has a different immutable decision");
          return json({ proposalRef: approvalInput.proposalRef, proposalSha256: approvalInput.proposalSha256, decision: approvalInput.decision, duplicate: true }, request.requestId);
        }
        // The approval that pins a route records it first: revision n+1 only when the route's digest changed, conditionally, never overwriting a revision. A route that is no
        // longer the one the proposal showed is refused here, before the approval is recorded.
        if (approvalInput.decision === "approve" && policy.modelRouteRevision !== null) {
          const unreadable = () => agentXError("RUNTIME_UNAVAILABLE", `${E2E_AGENT_UNAVAILABLE_REASONS.routeNotApproved}: The AI navigation settings of this installation could not be read; propose the setup again once they can be`);
          if (dependencies.e2eAgentInstallation === undefined) throw unreadable();
          let installation: E2EAgentInstallation;
          try { installation = await dependencies.e2eAgentInstallation(); } catch { throw unreadable(); }
          try {
            // The revision row records who approved it and for which project (audit; the installation's route is one for every project).
            await approveE2EAgentRoute({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }, installation, policy.modelRouteRevision,
              { approvedBy: identity.ownerKey, projectName: approvalInput.projectName });
          } catch (error) {
            if (error instanceof E2EModelRouteError) throw agentXError("RUNTIME_UNAVAILABLE", error.message);
            throw error;
          }
        }
        await dependencies.documentClient.send(new PutCommand({ TableName: dependencies.tableName, Item: {
          ...approvalKey, entityType: "PROJECT_SETUP_APPROVAL", ownerKey: identity.ownerKey, projectName: approvalInput.projectName,
          proposalRef: approvalInput.proposalRef, proposalSha256: approvalInput.proposalSha256, candidateDigest: proposal.candidateDigest,
          repositoryUrl: artifact.repositoryUrl, identityMapping, decision: approvalInput.decision, approvedAt: new Date().toISOString(),
          policyDigest: createHash("sha256").update(canonicalJson(policy), "utf8").digest("hex"), policy, targetIds: proposal.targets.map(target => target.targetId),
        }, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" }));
        return json({ proposalRef: approvalInput.proposalRef, proposalSha256: approvalInput.proposalSha256, decision: approvalInput.decision, duplicate: false }, request.requestId);
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/projects") {
        return json(await registerProject(dependencies, identity, body), request.requestId, 201);
      }
      if (url.pathname === "/v1/admin/credentials" && (request.method === "POST" || request.method === "GET")) {
        if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
        if (!dependencies.credentialRegistry) throw agentXError("RUNTIME_UNAVAILABLE", "connector credentials are not configured in this deployment");
        return request.method === "POST"
          ? json(await dependencies.credentialRegistry.register(identity, body), request.requestId, 201)
          : json(await dependencies.credentialRegistry.list(identity), request.requestId);
      }
      // RUN-3: when the browser and API runtime registrations expire, for agentx doctor (an administrator reads state and times only).
      if (request.method === "GET" && url.pathname === "/v1/admin/runtime-installation/status") {
        if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
        if (!dependencies.e2eFeatureRuntimeCatalogId) throw agentXError("NOT_FOUND", "browser and API runtimes are not set up in this deployment");
        return json(await readE2ERuntimeStatus({ runtimeCatalogId: dependencies.e2eFeatureRuntimeCatalogId, profileId: WEB_API_RUNTIME_PROFILE_ID,
          read: (key) => getItem<Record<string, unknown>>(dependencies, key) }), request.requestId);
      }
      // M1.4 Task 4.10C: the on-account model checks (a driving test of one model, or a discovery of the models this account sees), served by the qualified runner.
      const modelCheck = /^\/v1\/admin\/e2e\/model-checks(?:\/([0-9a-f-]{36}))?$/.exec(url.pathname);
      if (modelCheck !== null && ((request.method === "POST" && modelCheck[1] === undefined) || (request.method === "GET" && modelCheck[1] !== undefined) || (request.method === "GET" && url.pathname.endsWith("/model-checks")))) {
        if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
        if (request.method === "POST") await requirePricedTaskStopAdmission(dependencies, { orgId: identity.orgId, actor: { kind: "operator", id: auditOperatorId(identity.issuer, identity.subject) }, workKind: "admin-model-check" });
        return await adminModelChecks(dependencies, request.method, modelCheck[1], body, request.requestId);
      }
      // #343: Sign in with ChatGPT, for rovara doctor.
      if (request.method === "GET" && url.pathname === "/v1/admin/chatgpt") {
        if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
        if (!dependencies.chatgpt) throw agentXError("NOT_FOUND", "Sign in with ChatGPT is not set up in this deployment");
        return json(await dependencies.chatgpt.health(), request.requestId);
      }
      // Second review (switch `cr`): the writers of the evidence that lets a model block. Rovara staff on the hosted cloud, the install's administrator on Enterprise; never a company's member or project.
      const secondReviewEvidence = await routeSecondReviewEvidence(dependencies, identity, request, url, body);
      if (secondReviewEvidence !== undefined) return json(secondReviewEvidence.body, request.requestId, secondReviewEvidence.status);
      // Ruling R47: an operator sets the budgets of a private or single-org install's one org. A cloud install's orgs set their own.
      if (request.method === "PUT" && url.pathname === "/v1/admin/org/budget") {
        return json(await putInstallBudget(dependencies, identity, body), request.requestId);
      }
      // Plan 2, Task 18: Rovara staff decide the domains projects ask for.
      if (request.method === "GET" && url.pathname === "/v1/admin/egress/pending") {
        return json(await listEgressPending(dependencies, identity), request.requestId);
      }
      if (request.method === "POST" && (url.pathname === "/v1/admin/egress/approve" || url.pathname === "/v1/admin/egress/reject")) {
        return json(await decideEgress(dependencies, identity, url.pathname.endsWith("/approve") ? "approved" : "rejected", body), request.requestId);
      }
      if (request.method === "GET" && url.pathname === "/v1/admin/turns") {
        if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
        if (!dependencies.turnRecords) throw agentXError("RUNTIME_UNAVAILABLE", "turn records are not configured in this deployment");
        return json(await dependencies.turnRecords.page(url.searchParams), request.requestId);
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/workspaces/prepare") {
        return json(await prepareWorkspace(dependencies, identity, body), request.requestId, 202);
      }
      // Release 0.4.17: an operator connects a Slack workspace to a named org (an org of a cloud install has no other way to hold one).
      const slackTeamRoute = /^\/v1\/admin\/slack\/teams\/([^/]+)$/.exec(url.pathname);
      if (slackTeamRoute?.[1] && request.method === "PUT") {
        return json(await connectSlackTeam(dependencies, identity, slackTeamRoute[1], body), request.requestId);
      }
      if (slackTeamRoute?.[1] && request.method === "DELETE") {
        return json(await disconnectSlackTeam(dependencies, identity, slackTeamRoute[1]), request.requestId);
      }
      const slackBinding = /^\/v1\/admin\/slack\/bindings\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (slackBinding?.[1] && slackBinding[2] && request.method === "PUT") {
        return json(await putSlackBinding(dependencies, identity, slackBinding[1], slackBinding[2], body), request.requestId);
      }
      if (slackBinding?.[1] && slackBinding[2] && request.method === "DELETE") {
        return json(await deleteSlackBinding(dependencies, identity, slackBinding[1], slackBinding[2]), request.requestId);
      }
      // Spec 052: batches of eval runs, started, shown, stopped and read by an administrator of the channel's project.
      if (url.pathname === "/v1/admin/evals/batches" && request.method === "POST") {
        return json(await routeStartEvalBatch(dependencies, identity, body), request.requestId);
      }
      const evalBatch = /^\/v1\/admin\/evals\/batches\/([0-9a-f-]{36})(?:\/(stop|results))?$/.exec(url.pathname);
      if (evalBatch?.[1]) {
        const action = evalBatch[2];
        if ((action === undefined || action === "results") && request.method === "GET") {
          return json(await routeEvalBatch(dependencies, identity, evalBatch[1], action ?? "show"), request.requestId);
        }
        if (action === "stop" && request.method === "POST") return json(await routeEvalBatch(dependencies, identity, evalBatch[1], "stop"), request.requestId);
      }
      const evalChannel = /^\/v1\/admin\/evals\/channels\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (evalChannel?.[1] && evalChannel[2] && (request.method === "PUT" || request.method === "DELETE" || request.method === "GET")) {
        return json(await routeSwebenchChannel(dependencies, identity, request.method, evalChannel[1], evalChannel[2], body), request.requestId);
      }
      const cancelTask = /^\/v1\/admin\/workspaces\/([0-9a-f-]+)\/cancel$/.exec(url.pathname);
      if (request.method === "POST" && cancelTask?.[1]) {
        return json(await cancelWorkspaceTask(dependencies, identity, cancelTask[1]), request.requestId, 202);
      }
      const stop = /^\/v1\/admin\/workspaces\/([0-9a-f-]+)\/stop$/.exec(url.pathname);
      if (request.method === "POST" && stop?.[1]) {
        return json({ workspace: await stopWorkspace(dependencies, identity, stop[1]) }, request.requestId, 202);
      }
      // Spec 025 C25: an admin switches a shared task's mode, within its project's policy.
      // Any segment: a mistyped task ID gets TASK_NOT_FOUND from the handler, not the catch-all refusal.
      const taskE2EReplay = /^\/v1\/admin\/tasks\/([^/]+)\/e2e-replay$/.exec(url.pathname);
      if ((request.method === "POST" || request.method === "GET") && taskE2EReplay?.[1]) {
        return json(await adminTaskE2EReplay(dependencies, identity, taskE2EReplay[1], request.method, body, url.searchParams), request.requestId, request.method === "POST" ? 202 : 200);
      }
      const taskShareMode = /^\/v1\/admin\/tasks\/([^/]+)\/share-mode$/.exec(url.pathname);
      if (request.method === "POST" && taskShareMode?.[1]) {
        return json(await adminTaskShareMode(dependencies, identity, taskShareMode[1], body, tasks), request.requestId);
      }

      // Developer workflows run in Slack threads, which reach the same handlers through
      // /v1/service/*. The OIDC entry point serves administration only.
      throw agentXError(
        "FORBIDDEN",
        "AgentX developer workflows run in the project's Slack channel; this endpoint serves administration only",
      );
    } catch (error) {
      // Confirmation and task pages remain isolated even when their adapter throws before rendering.
      const errorPath = request.path.split("?", 1)[0]!;
      const isolate = isDecidePagePath(errorPath) || TASK_PAGE.test(errorPath) || TASK_PEOPLE_CONFIRMATION.test(errorPath);
      if (error instanceof ProcessModelRefusal) return json({error:processModelRefusalBody(error)},request.requestId,error.statusCode);
      if (error instanceof AgentXError) {
        // A decision that needs a person present says where to go (`confirmUrl` for a token, `signInUrl` for a browser): R66.
        const response = json({ error: { code: error.code, message: stripCode(error.message, error.code), ...("reason" in error && error.reason === "settingsChanged" ? {reason:"settingsChanged"} : {}), ...(error instanceof DecideReauthRequired ? error.details : {}), ...(error instanceof TaskStopReadinessError ? { resource: error.resource } : {}) } }, request.requestId, error.statusCode);
        return isolate ? withDecideIsolation(response) : response;
      }
      const response = unexpectedErrorAnswer(error, request.requestId);
      return isolate ? withDecideIsolation(response) : response;
    }
  };
}
