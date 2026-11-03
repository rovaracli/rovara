// The code now lives in ./developer-routes/ (split by scripts/split/split-developer.ts); this file composes it and keeps the original export list.
// The file's own imports, first and in their old order, so every dependency loads exactly as it did before the split.
import { SPEC_CHOICE_ROUTE, SPEC_PAGE_CHOICES, routeSpecChoice } from "./developer-routes/spec-routes.js";
import { getInstallInfo } from "./developer-routes/install.js";
import { isSsoRoute, routeSsoRequest } from "./developer-routes/sso.js";
import { isCompanyDomainsRoute, routeCompanyDomains } from "./developer-routes/company-domains.js";
import { specOwnerChoice } from "./developer-tasks/spec-wiring.js";
import "../org/task-stop-unpriced.js";
import "../org/task-stop-editing.js";
import "../org/service-status.js";
import "../model-selection/company-prepare.js";
import "../model-selection/company-approval.js";
import "@agentx/contracts";
import "../model-selection/policy-preview.js";
import "../model-selection/company-read.js";
import "../model-selection/read.js";
import "../model-selection/snapshot.js";
import "../org/project-slack-browser-http.js";
import "../org/project-allowed-domains-http.js";
import "../org/second-person-evidence.js";
// Lane A G1: catalog-bound project money source, no setter or lifecycle claim.
import "../org/task-stop-project.js";
// Lane A G1: existing agent money limit, no initialization or management.
import "../org/task-stop-agent.js";
// Lane A G1: configured company-default read, with no policy writer.
import "../org/task-stop-company.js";
// Lane A G1: narrow read of the existing company ceiling.
import "../org/task-stop-ceiling.js";
// Lane A: read-only monthly base settings; no legacy proxy sync.
import "../org/admin-budget-settings.js";
import "../org/invite-creation.js";
import "../org/invite-status.js";
import "../org/slack-workspace-evidence.js";
import "../org/project-working-branch-save-http.js";
import "../org/project-working-branch-context.js";
import "../org/project-working-branch-http.js";
import "../org/reviewed-project-restore-app.js";
import "../org/reviewed-project-archive-app.js";
import "../org/invite-revocation.js";
import "../developer/log.js";
import "../org/invite-directory.js";
import "../org/role-changes.js";
import "../org/directory.js";
import "../org/member-removal/routes.js";
import "../app-nav/read-cache.js";
import "../app-nav/nav.js";
import "../agent-sessions/live.js";
import "../agent-sessions/home.js";
import "../agent-sessions/read.js";
import "../agents/roster.js";
import "../agents/access.js";
// Spec 025 FR-009, FR-013, FR-014 and FR-016: GET projects, and the project access check the task
// routes use. /v1/dev/* has no API Gateway authorizer (D17): the broker verifies the developer
// access token itself, then checks the environment, the method and the sign-in session on every
// request (R12, R13), so a revoked session stops at once.
import "../rovara-code/task-view-compat.js";
import "../triggers/hooks.js";
import "../triggers/lifecycle.js";
import "../developer/access.js";
import "../org/egress-domains.js";
import "../model-sources/routes.js";
import "../model-sources/release.js";
import "../org/project-archive.js";
import "../org/project-settings.js";
import "../developer/project-roles.js";
import "../org/slack-binding.js";
import "../org/project-members.js";
import "../developer/task-project-access.js";
import "../org/invite-url.js";
import "../org/cloud-projects.js";
import "../org/budget.js";
import "../audit/routes.js";
import "../audit/view-page.js";
import "../developer/task-person-identity.js";
import "../developer/task-people-display-budget.js";
import "../developer/person-name.js";
import "../developer/chosen-name.js";
import "../developer/store.js";
import "../developer/task-records.js";
import "../developer/limits.js";
import "./stuck-setup.js";
import "./setup-check-close.js";
import "../org/trial.js";
import "../org/project-setup-check.js";
import "./developer-tasks.js";
import "./status-reply.js";
import "../agents/models-route.js";
import "../agents/routes.js";
import "../chains/routes.js";
import "../chains/runner.js";
import "../chains/session-seam.js";
import "../chains/view-ports.js";
import "../realtime/sink.js";
import "../agent-sessions/routes.js";
import "../agent-sessions/lifecycle.js";
import "../learning/cleanup.js";
import "../agent-sessions/stop.js";
import "../agent-sessions/access.js";
import "../devices/routes.js";
import "../connections/store.js";
import "../agents/runs.js";
import "../rovara-code/routes.js";
import "../rovara-code/code-settings.js";
import "../playbook/project-process.js";
import "../learning/capture-comment.js";
import "../learning/routes.js";
import "../learning/settings-routes.js";
import "../playbook/routes.js";
import "../rovara-code/merge.js";
import "../rovara-code/setup-draft.js";
import "../rovara-code/intent.js";
import "../agents/run-version-gate.js";
import "../spend/requests.js";
import "./feedback-review-web.js";
import "./task-web.js";
import "./task-web-api.js";
import "./task-e2e-artifact.js";
import { readOrgServiceStatus } from "../org/service-status.js";
import { CompanySameModelPolicyRefusal } from "../model-selection/company-prepare.js";
import { updateCompanyModelPolicy } from "../model-selection/company-approval.js";
import { ModelSelectionPolicyAppliedSchema, ModelSelectionPolicyPendingSchema, ReviewDefaultNoticeBodySchema } from "@agentx/contracts";
import { previewCompanyModelPolicy } from "../model-selection/policy-preview.js";
import { requireCompanyModelPolicyAuthority, getCompanyModelSelectionPolicy } from "../model-selection/company-read.js";
import { getStageModels } from "../model-selection/read.js";
import { loadStageModelSnapshot } from "../model-selection/snapshot.js";
import { projectSlackBrowserHttp } from "../org/project-slack-browser-http.js";
import { projectAllowedDomainsHttp } from "../org/project-allowed-domains-http.js";
import { getTaskStopProject } from "../org/task-stop-project.js";
import { getTaskStopAgent } from "../org/task-stop-agent.js";
import { getTaskStopCompany } from "../org/task-stop-company.js";
import { getTaskStopCeiling } from "../org/task-stop-ceiling.js";
import { getAdminBudgetSettings } from "../org/admin-budget-settings.js";
import { createReviewedOrganizationInvite, getInviteCreationReceipt } from "../org/invite-creation.js";
import { getOrganizationInviteStatus } from "../org/invite-status.js";
import { readSlackWorkspaceEvidence } from "../org/slack-workspace-evidence.js";
import { projectWorkingBranchSaveHttp } from "../org/project-working-branch-save-http.js";
import { readProjectWorkingBranchContextHttp } from "../org/project-working-branch-context.js";
import { readProjectWorkingBranchHttp } from "../org/project-working-branch-http.js";
import { readReviewedProjectRestoreAppPreview } from "../org/reviewed-project-restore-app.js";
import { readReviewedProjectArchiveAppPreview } from "../org/reviewed-project-archive-app.js";
import { revokeOrganizationInvite } from "../org/invite-revocation.js";
import { logDeveloperEvent } from "../developer/log.js";
import { listOrganizationInvites } from "../org/invite-directory.js";
import { OrgMemberRoleChangeBodySchema } from "@agentx/contracts";
import { listOrganizationMembers, lookupOrganizationMember } from "../org/directory.js";
import { getMemberRemoval, previewMemberRemoval, startMemberRemovalRoute } from "../org/member-removal/routes.js";
import { taskResponseForClient } from "../rovara-code/task-view-compat.js";
import { AgentXNameSchema, RenameOrganizationBodySchema, agentXError, projectAllows } from "@agentx/contracts";
import { requireReviewedModelSourceWebWrite } from "../model-sources/routes.js";
import { restoreProjectReviewedWithEffects, archiveProjectReviewedWithEffects } from "../org/project-archive.js";
import { effectiveProjectRole, requireNewWorkAllowed } from "../developer/project-roles.js";
import { isAuditOrgPath, routeAuditRequest } from "../audit/routes.js";
import { requireFreshSignInForExport, startsAuditExport } from "./developer-routes/audit-export-fresh.js";
import { canReadAuditLog, requireAuditorRoute } from "../org/auditor.js";
import { createAuditViewPage, isAuditViewPath } from "../audit/view-page.js";
import {
  createPageComment,
  decideOnPage,
  deletePageComment,
  editPageComment,
  getTaskDocumentView,
  getTaskFreshness,
  getTaskPageState,
  listPageComments,
  retryApplicationRoundOnPage,
  reviseTaskWorkflowPlan,
  setPageSuggestion,
  confirmTaskPeopleProposal,
  getTaskPeopleCapabilities,
  getTaskPeopleForPage,
  getTaskPeopleProposal,
  getTaskPeopleProposalMetadata,
  getTaskPersonPresentationName,
  proposeTaskOwnershipForPage,
  proposeTaskPeopleRoleForPage,
  getWorkflowFeedbackReview,
  routeDeveloperTaskRequest,
  submitWorkflowFeedbackDecision,
} from "./developer-tasks.js";
import type { AdaptedHttpRequest } from "./lambda.js";
import { routeIntake } from "./developer-routes/intake.js";
import { routeTestEnvironment, testEnvStoreOf } from "./developer-routes/test-environment.js";
import { routeTestHealth } from "./developer-routes/test-health.js";
import { KNOWN_FAILING_MARKS_BROWSER_MESSAGE, KNOWN_FAILING_MARKS_PATH, routeKnownFailingMarks } from "./developer-routes/known-failing-marks.js";
import { verifyResultsEnabled } from "../verification/switch.js";
import { KNOWN_FAILING_POLICY_BROWSER_MESSAGE, KNOWN_FAILING_POLICY_PATH, routeKnownFailingPolicy } from "./developer-routes/known-failing-policy.js";
import { SECOND_REVIEW_ACK_BROWSER_MESSAGE, acknowledgeSecondReview } from "./developer-tasks/second-review-ack.js";
import { SECOND_REVIEW_BROWSER_MESSAGE, SECOND_REVIEW_PATH, routeSecondReview } from "./developer-routes/second-review.js";
import { routeTrackerPeople } from "./developer-routes/tracker-people.js";
import { routeJiraOrgAdmin } from "./developer-routes/jira-org-admin.js";
import { SETUP_RECIPES_BROWSER_MESSAGE, isSetupRecipesPath, routeSetupRecipes } from "./developer-routes/setup-recipes.js";
import { setupRecipesEnabled } from "../rovara-code/setup-recipes-switch.js";
import { SAVED_ENV_IMAGE_BROWSER_MESSAGE, isSavedEnvImagePath, routeSavedEnvImage } from "./developer-routes/saved-env-image.js";
import { savedEnvEnabled } from "../test-env/saved-env-switch.js";
import { nightlyHooks } from "../test-env/nightly-wiring.js";
import { StatusReply } from "./status-reply.js";
import { getModels } from "../agents/models-route.js";
import { isAgentRoute, routeAgentRequest } from "../agents/routes.js";
import { isChainRoute, routeChainRequest } from "../chains/routes.js";
import { isAgentSessionRoute, routeAgentSessionRequest } from "../agent-sessions/routes.js";
import { isDiagnosisPath, routeDiagnosisRequest } from "../diagnosis/routes.js";
import { isDeviceRoute, routeDeviceRequest } from "../devices/routes.js";
import { CODE_INTENT_PATH, routeCodeIntentStart } from "../rovara-code/routes.js";
import { getCodeSettings, putCodeSettings } from "../rovara-code/code-settings.js";
import { HOW_WE_WORK_PATH, PLAYBOOK_PATH, PLAYBOOK_PROCESS_PATH, getProjectHowWeWork, routeProjectPlaybook, routeProjectProcess } from "../playbook/routes.js";
import { applySetupDraft, getSetupDraft, startSetupDraft } from "../rovara-code/setup-draft.js";
import { createFeedbackReviewWeb } from "./feedback-review-web.js";
import { TASK_PAGE, TASK_PEOPLE_CONFIRMATION, TASK_STATUS, createTaskWeb } from "./task-web.js";
import { TASK_PAGE_API_PREFIX, createTaskWebApi } from "./task-web-api.js";
import { getTaskE2EArtifact } from "./task-e2e-artifact.js";
import { EVIDENCE_DOWNLOAD_PATH, routeEvidenceDownload } from "./task-evidence-download.js";
import { isDecisionPath, decisionRouteDepsOf } from "./developer-routes/decisions.js";
import { routeSetupAgent } from "./developer-routes/setup-agent.js";
import { routeDecisionCards } from "../decisions/routes.js";
import { designPlaybookDeps, isDesignReviewPath, routeDesignReview } from "./developer-routes/design-review.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./developer-routes/types.js";
import { PROJECT_NOT_FOUND_IN_APP, bodyError } from "./developer-routes/common.js";
import { authenticateDeveloper, authenticateDeveloperSessionId } from "./developer-routes/authentication.js";
import { listAppProjects, listProjects } from "./developer-routes/project-list.js";
import { changeProjectArchive, egressDepsOf, startProjectSetupCheck } from "./developer-routes/project-archive-setup.js";
import {
  deleteProjectMember,
  deleteProjectSlackChannel,
  getProjectMembers,
  projectRoleForRoute,
  putProjectMember,
  putProjectSlackChannel,
} from "./developer-routes/project-members.js";
import { listGithubRepositories, projectMetaConfigRoute } from "./developer-routes/project-settings.js";
import { getAppProjectWithProof, putProjectSettingsChecked, undoToProvenSetup } from "./developer-routes/settings-proof.js";
import { listWorkspaces } from "./developer-routes/project-access.js";
import {
  chainRouteDependenciesFor,
  codeIntentDependenciesOf,
  developerTaskRouteDependencies,
  gateDeveloperStart,
  sessionDependenciesOf,
  sessionReadDependencies,
  diagnosisRouteDepsOf,
  setupDraftDepsOf,
  startAppRun,
} from "./developer-routes/dependencies.js";
import {
  CHATGPT_CONNECTION_PATH,
  changeMemberRole,
  createOrganizationInvite,
  createProject,
  getAppMe,
  getAppNavigation,
  getBudget,
  getOrganization,
  jsonBody,
  leaveOrganization,
  putOrganizationBudget,
  removalHelpers,
  removeOrganizationMember,
  routeChatGptConnection,
  setMyName,
  startAppIdentityLink,
  unlinkAppIdentity,
} from "./developer-routes/organization.js";
export {
  type ChannelMembersInvokeResult,
  type DeveloperApiConfiguration,
  type DeveloperCaller,
  type DeveloperRouteDependencies,
  type ProjectAccessCaller,
} from "./developer-routes/types.js";
export {
  channelByNameThroughLambda,
  channelInfoThroughLambda,
  channelMembersThroughLambda,
  developerKeysThroughLambda,
  developerSinceFromEnvironment,
  endDeveloperSessionsThroughLambda,
  realtimeTokenThroughLambda,
  slackAuthCheckThroughLambda,
  slackUserByEmailThroughLambda,
  startIdentityLinkThroughLambda,
  taskChannelPeopleThroughLambda,
  taskPeopleDisplayReadThroughLambda,
  taskPersonProofThroughLambda,
  unlinkIdentityThroughLambda,
} from "./developer-routes/identity-lambda.js";
export {
  type DeveloperTokenClaims,
  authenticateBearer,
  authenticateDeveloper,
  authenticateDeveloperSessionId,
  developerClaims,
} from "./developer-routes/authentication.js";
import { LEARNING_PATH, routeLearning } from "../learning/routes.js";
import { routeLessonsFor, routeLoadedKnowledgeFor } from "./developer-routes/lessons.js";
import { LEARNING_SETTINGS_PATH, routeLearningSettings } from "../learning/settings-routes.js";
import { REVIEW_DEFAULT_NOTICE_PATH, dismissReviewDefaultNotice, readReviewDefaultNotice } from "../model-selection/review-default-notice.js";
import { clearArchivedProjectLearning } from "./developer-routes/project-archive-setup.js";
import { forgetTaskComment, rememberTaskComment } from "../learning/capture-comment.js";
import { getTaskStopEditing, writeTaskStopEditing } from "../org/task-stop-editing.js";
export { projectMembersOf, projectsWithPolicy } from "./developer-routes/project-list.js";
export { checkProjectAccess } from "./developer-routes/project-access.js";
export { agentRunStarterOf, codeIntentDependenciesOf, developerTaskRouteDependencies } from "./developer-routes/dependencies.js";
export { CHATGPT_CONNECTION_PATH } from "./developer-routes/organization.js";

export { StatusReply };

export { effectiveProjectRole, requireNewWorkAllowed };

export async function routeDeveloperRequest(deps: DeveloperRouteDependencies, request: AdaptedHttpRequest, url: URL, authenticated?: { caller: DeveloperCaller; csrf: string }): Promise<unknown> {
  if(request.method==="PUT"&&url.pathname==="/v1/app/org/model-selection-policy"&&authenticated?.caller.browserSession!==true)throw agentXError("FORBIDDEN","Use a live browser session to change company model policy.");
  // Website proposal routes accept only the trusted opaque-cookie adapter.
  // Reject token callers before authentication or any project/proposal lookup.
  if (/^\/v1\/app\/projects\/[^/]+\/allowed-websites(?:\/|$)/.test(url.pathname) && authenticated?.caller.browserSession !== true) {
    throw agentXError("FORBIDDEN", "Use a live browser session for allowed websites.");
  }
  // v1.2 learning (the view and the writes: Remember, Forget, Accept, Dismiss, Reopen, Remove) is browser-only. Refused here, before authentication or any read, so a token learns nothing about a suggestion or rule.
  if (/^\/v1\/app\/projects\/[^/]+\/learning(?:\/|$)/.test(url.pathname) && authenticated?.caller.browserSession !== true) {
    throw agentXError("FORBIDDEN", "Use a live browser session for learning changes.");
  }
  // The company's master suggestions switch is browser-only too: no token, CLI or Slack path reads or changes it.
  if (url.pathname === LEARNING_SETTINGS_PATH && authenticated?.caller.browserSession !== true) {
    throw agentXError("FORBIDDEN", "Use a live browser session for learning changes.");
  }
  // The one-time review-default notice (reading it and dismissing it) is browser-only, like the other company settings.
  if (url.pathname === REVIEW_DEFAULT_NOTICE_PATH && authenticated?.caller.browserSession !== true) {
    throw agentXError("FORBIDDEN", "Use a live browser session for this notice.");
  }
  // The company setting "always two people" for known-failing marks: changing it is browser-only (the read is open to members).
  if (url.pathname === KNOWN_FAILING_POLICY_PATH && request.method === "POST" && authenticated?.caller.browserSession !== true) throw agentXError("FORBIDDEN", KNOWN_FAILING_POLICY_BROWSER_MESSAGE);
  if (url.pathname === SECOND_REVIEW_PATH && request.method === "POST" && authenticated?.caller.browserSession !== true) throw agentXError("FORBIDDEN", SECOND_REVIEW_BROWSER_MESSAGE);
  if (/\/tasks\/[^/]+\/second-review-acknowledge$/u.test(url.pathname) && request.method === "POST" && authenticated?.caller.browserSession !== true) throw agentXError("FORBIDDEN", SECOND_REVIEW_ACK_BROWSER_MESSAGE);
  // The project's known-failing marks (list and Undo) are browser-only for both methods, while vx is on (off: the path is not found, as any unknown path).
  if (KNOWN_FAILING_MARKS_PATH.test(url.pathname) && verifyResultsEnabled() && authenticated?.caller.browserSession !== true) throw agentXError("FORBIDDEN", KNOWN_FAILING_MARKS_BROWSER_MESSAGE);
  // Company setup recipes and locks (switch `sp`): browser-only for reads and writes (off: the path is not found).
  if (isSetupRecipesPath(url.pathname) && setupRecipesEnabled() && authenticated?.caller.browserSession !== true) throw agentXError("FORBIDDEN", SETUP_RECIPES_BROWSER_MESSAGE);
  // The project's saved environment panel (switch `sv`): browser-only for reads and writes, whatever the method (off: the path is not found).
  if (isSavedEnvImagePath(url.pathname) && savedEnvEnabled() && authenticated?.caller.browserSession !== true) throw agentXError("FORBIDDEN", SAVED_ENV_IMAGE_BROWSER_MESSAGE);
  // B34 reviewed reads/unbind are cookie-only; existing token Slack routes remain separate.
  if (/^\/v1\/app\/projects\/[^/]+\/slack-channel\/(links|review|requests|unbind|proposals|decisions)(?:\/|$)/.test(url.pathname) && authenticated?.caller.browserSession !== true) {
    throw agentXError("FORBIDDEN", "Use a live browser session for Slack linking.");
  }
  // The browser pages sign in with the opaque review session cookie, re-read (with the membership) on every request.
  const authenticateSession = async (sessionId: string) => {
    try { return await authenticateDeveloperSessionId(deps, sessionId); }
    catch { return undefined; }
  };
  // I2: the task and review pages are not for the Auditor, which reads the audit log and nothing else; a session that holds that role is signed out of them.
  const authenticatePersonSession = async (sessionId: string) => {
    const who = await authenticateSession(sessionId);
    return who?.orgRole === "auditor" ? undefined : who;
  };
  // The audit page (Task 13): a read-only view for the org's owners, admins and Auditors; the org is the session's own.
  if (isAuditViewPath(url.pathname)) {
    return createAuditViewPage({ origin: new URL(deps.developer.issuer).origin, authenticateSession, ledger: deps.auditLedger })(request, url);
  }
  // RULING Q37: Plan 7 Task 14 shared links are served exclusively by WebAppFunction.
  if (url.pathname.startsWith("/s/")) throw agentXError("NOT_FOUND", "route not found");
  if (url.pathname.startsWith("/review/")) {
    if (deps.tasks === undefined) throw agentXError("NOT_FOUND", "developer tasks are not set up in this deployment");
    // Task 18: the read-only task page and its "moved on" check; every other /review/ path is the PR-feedback review.
    // Spec 061 slice 2: the page's JSON API is matched here too, so the PR-feedback page never sees its paths.
    if (TASK_PAGE.test(url.pathname) || TASK_PEOPLE_CONFIRMATION.test(url.pathname) || TASK_STATUS.test(url.pathname) || TASK_PAGE_API_PREFIX.test(url.pathname)) {
      const routeDeps = (caller: DeveloperCaller) => developerTaskRouteDependencies(deps, caller);
      return createTaskWeb({
        authenticateSession: authenticatePersonSession,
        getTaskDocumentView: (caller, taskId) => getTaskDocumentView(routeDeps(caller), caller, taskId),
        getTaskFreshness: (caller, taskId) => getTaskFreshness(routeDeps(caller), caller, taskId),
        getTaskPeople: (caller, taskId) => getTaskPeopleForPage(routeDeps(caller), caller, taskId),
        getTaskPeopleRequest: (caller, taskId, requestId) => getTaskPeopleProposal(routeDeps(caller), caller, taskId, requestId),
        getTaskPeopleProposalMetadata: (caller, taskId, requestId) => getTaskPeopleProposalMetadata(routeDeps(caller), caller, taskId, requestId),
        getTaskPersonName: (caller, taskId, personId) => getTaskPersonPresentationName(routeDeps(caller), taskId, personId),
        getTaskPeopleCapabilities: (caller, taskId) => getTaskPeopleCapabilities(routeDeps(caller), caller, taskId),
        api: createTaskWebApi({
          origin: deps.developer.issuer,
          log: logDeveloperEvent,
          authenticateSession: authenticatePersonSession,
          taskState: (caller, taskId) => getTaskPageState(routeDeps(caller), caller, taskId),
          listComments: (caller, taskId) => listPageComments(routeDeps(caller), caller, taskId),
          createComment: (caller, taskId, input) => createPageComment(routeDeps(caller), caller, taskId, input),
          editComment: (caller, taskId, input) => editPageComment(routeDeps(caller), caller, taskId, input),
          deleteComment: (caller, taskId, input) => deletePageComment(routeDeps(caller), caller, taskId, input),
          setSuggestion: (caller, taskId, input) => setPageSuggestion(routeDeps(caller), caller, taskId, input),
          rememberComment: (caller, taskId, commentId) => rememberTaskComment(routeDeps(caller), caller, taskId, commentId, { audit: deps.agents?.audit }),
          forgetComment: (caller, taskId, commentId) => forgetTaskComment(routeDeps(caller), caller, taskId, commentId, { audit: deps.agents?.audit }),
          decide: (caller, taskId, input) => decideOnPage(routeDeps(caller), caller, taskId, input),
          retryApplicationRound: (caller, taskId, input) => retryApplicationRoundOnPage(routeDeps(caller), caller, taskId, input),
          // Wire lane D (MD-1): the owner's choice on a spec on hold (the same function as POST /v1/app/tasks/{id}/spec/{choice}).
          specChoice: (caller, taskId, choice) => specOwnerChoice(routeDeps(caller), caller, taskId, SPEC_PAGE_CHOICES[choice]),
          revisePlan: async (caller, taskId, input) => { await reviseTaskWorkflowPlan(routeDeps(caller), caller, taskId, input); return { revision: (await getTaskFreshness(routeDeps(caller), caller, taskId)).revision }; },
          readE2EArtifact: (caller, taskId, sha256) => getTaskE2EArtifact(routeDeps(caller), caller, taskId, sha256),
          getPeople: (caller, taskId) => getTaskPeopleForPage(routeDeps(caller), caller, taskId),
          proposePeopleRole: (caller, taskId, input) => proposeTaskPeopleRoleForPage(routeDeps(caller), caller, taskId, input),
          proposeOwnership: (caller, taskId, input) => proposeTaskOwnershipForPage(routeDeps(caller), caller, taskId, input),
          getPeopleRequest: (caller, taskId, requestId) => getTaskPeopleProposal(routeDeps(caller), caller, taskId, requestId),
          confirmPeopleRequest: (caller, taskId, requestId) => confirmTaskPeopleProposal(routeDeps(caller), caller, taskId, requestId),
        }),
      })(request, url);
    }
    const web = createFeedbackReviewWeb({
      origin: new URL(deps.developer.issuer).origin,
      authenticateSession: authenticatePersonSession,
      getWorkflowFeedbackReview: (caller, taskId) => getWorkflowFeedbackReview(developerTaskRouteDependencies(deps, caller), caller, taskId),
      submitWorkflowFeedbackDecision: (caller, taskId, input) => submitWorkflowFeedbackDecision(developerTaskRouteDependencies(deps, caller), caller, taskId, input),
      now: deps.now,
    });
    return web(request, url);
  }
  // Never request.jwtClaims: no API Gateway authorizer runs on /v1/dev/* (D17).
  const caller = authenticated?.caller ?? await authenticateDeveloper(deps, await deps.developer.verifyAccessToken(request.headers.authorization));
  // I2: before any route is matched, an Auditor is held to its allow-list (the audit log, its exports, its own identity). Nothing below this line runs for it otherwise.
  requireAuditorRoute(caller, request.method, url.pathname);
  // Lane C6: only the trusted cookie adapter supplies authenticated; source guards share the handlers' paths.
  if (authenticated !== undefined) requireReviewedModelSourceWebWrite(request, url);
  // Plan 3's paths, project sub-paths included, are matched before Plan 2's `/v1/app/projects/{name}*` handlers (PF24).
  if (request.method === "GET" && url.pathname === "/v1/app/models") {
    if (deps.agents === undefined) throw agentXError("NOT_FOUND", "agents are not set up in this deployment");
    return getModels(deps.agents, caller, url);
  }
  if (isAgentRoute(url.pathname)) {
    if (deps.agents === undefined) throw agentXError("NOT_FOUND", "agents are not set up in this deployment");
    return routeAgentRequest({ ...deps.agents, startRun: (_agentCaller, input) => startAppRun(deps, caller, input) }, caller, request, url);
  }
  // Plan 4's chains (`/v1/app/chains*`, `/v1/app/chain-runs*`), beside Plan 3's agents.
  if (isChainRoute(url.pathname)) {
    const chainDeps = chainRouteDependenciesFor(deps, caller);
    if (chainDeps === undefined) throw agentXError("NOT_FOUND", "chains are not set up in this deployment");
    // Rovara Code (Plan 6): a step's task is read like any task, so a client without `x-agentx-task-view: 2` gets the version 1 projection of it.
    return taskResponseForClient(await routeChainRequest(chainDeps, caller, request, url), request.headers);
  }
  // Plan 5, Task 5: `/v1/app/sessions*`.
  if (request.method === "GET" && url.pathname === "/v1/app/nav") return getAppNavigation(deps, caller);
  if (isAgentSessionRoute(url.pathname)) return routeAgentSessionRequest(sessionReadDependencies(deps, caller), caller, request, url);
  // Live interaction F2 to F4: Fix with agent (`/v1/app/diagnoses*`); the dependencies exist only while the `fd` switch is on.
  if (isDiagnosisPath(url.pathname)) return (await routeDiagnosisRequest(diagnosisRouteDepsOf(deps, caller), caller, request.method, url.pathname, () => jsonBody(request)))!;
  // Proof and evidence (wire-proof): one stored artifact of a task's evidence. A route only while the proof switch is on (`deps.evidence`); with it off the path is not matched and falls through as any unknown path.
  const evidenceDownload = request.method === "GET" && deps.evidence !== undefined ? EVIDENCE_DOWNLOAD_PATH.exec(url.pathname) : null;
  if (evidenceDownload !== null) {
    const found = await routeEvidenceDownload({ deps: developerTaskRouteDependencies(deps, caller), caller, taskId: evidenceDownload[1]!, sha256: evidenceDownload[2]!, requestId: request.requestId, now: deps.now });
    if (found !== undefined) return found;
  }
  // Decision cards (wire-proof): `/v1/app/decisions*`. The dependencies exist only while the cards switch is on; with it off the path falls through as any unknown path.
  if (isDecisionPath(url.pathname)) {
    const cardDeps = decisionRouteDepsOf(deps, caller);
    if (cardDeps !== undefined) {
      const answer = await routeDecisionCards(cardDeps, caller, { method: request.method, pathname: url.pathname, searchParams: url.searchParams, body: request.method === "POST" ? jsonBody(request) : undefined });
      if (answer !== undefined) return answer;
    }
  }
  // Plan 5, Tasks 17, 18 and 22: `/v1/app/devices*` (the Mac's command poll, and a removal that ends the sessions on it) and `/v1/app/org/local-agents`.
  if (isDeviceRoute(url.pathname)) {
    const log = sessionDependenciesOf(deps)?.log;
    return routeDeviceRequest({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, ...(log === undefined ? {} : { log }), ...(deps.audit === undefined ? {} : { audit: deps.audit }) }, caller, request, url);
  }
  if (request.method === "GET" && url.pathname === "/v1/app/install") return getInstallInfo(deps);
  if (isSsoRoute(url.pathname)) return routeSsoRequest(deps, caller, request, url.pathname);
  // Company domain verification: the owner's domains page (owner only; every edition).
  if (isCompanyDomainsRoute(url.pathname)) return routeCompanyDomains(deps, caller, request, url.pathname);
  if (request.method === "GET" && url.pathname === "/v1/app/me") {
    const me = await getAppMe(deps, caller);
    return authenticated === undefined ? me : { ...me, csrf: authenticated.csrf };
  }
  if (request.method === "GET" && url.pathname === "/v1/dev/projects") return listProjects(deps, caller);
  if (request.method === "GET" && url.pathname === "/v1/app/projects") return listAppProjects(deps, caller, url.searchParams.get("include") === "archived");
  const appProject = /^\/v1\/app\/projects\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && appProject !== null) return getAppProjectWithProof(deps, caller, appProject[1]!);
  const projectSettingsRoute = /^\/v1\/app\/projects\/([^/]+)\/settings$/.exec(url.pathname);
  if (request.method === "PUT" && projectSettingsRoute !== null) return putProjectSettingsChecked(deps, caller, projectSettingsRoute[1]!, jsonBody(request));
  // TE-4: a maintainer in a browser, signed in within ten minutes, goes back to the last proved setup.
  const projectSettingsUndo = /^\/v1\/app\/projects\/([^/]+)\/settings\/undo$/.exec(url.pathname);
  if (request.method === "POST" && projectSettingsUndo !== null) return undoToProvenSetup(deps, caller, projectSettingsUndo[1]!, jsonBody(request));
  const metaConfigRoute = /^\/v1\/app\/projects\/([^/]+)\/meta-config(?:\/(apply|dismiss|check))?$/.exec(url.pathname);
  if (metaConfigRoute !== null && (request.method === "GET" || request.method === "POST")) return projectMetaConfigRoute(deps, caller, metaConfigRoute[1]!, metaConfigRoute[2], request.method, request.method === "POST" ? jsonBody(request) : undefined);
  const projectMembersRoute = /^\/v1\/app\/projects\/([^/]+)\/members(?:\/([a-f0-9]{64}))?$/.exec(url.pathname);
  if (projectMembersRoute !== null) {
    if (request.method === "GET" && projectMembersRoute[2] === undefined) return getProjectMembers(deps, caller, projectMembersRoute[1]!);
    if (request.method === "PUT" && projectMembersRoute[2] !== undefined) return putProjectMember(deps, caller, projectMembersRoute[1]!, projectMembersRoute[2], jsonBody(request));
    if (request.method === "DELETE" && projectMembersRoute[2] !== undefined) return deleteProjectMember(deps, caller, projectMembersRoute[1]!, projectMembersRoute[2], jsonBody(request));
  }
  const websiteReview = /^\/v1\/app\/projects\/([^/]+)\/allowed-websites$/.exec(url.pathname);
  if (request.method === "GET" && websiteReview !== null) return projectAllowedDomainsHttp({ ...deps, ...deps.projectAllowedDomains, signInTableName: deps.developer.signInTableName }, caller, websiteReview[1]!, { operation: "review", expectedOrgId: url.searchParams.get("expectedOrgId") });
  if (request.method === "POST" && websiteReview !== null) return projectAllowedDomainsHttp({ ...deps, ...deps.projectAllowedDomains, signInTableName: deps.developer.signInTableName }, caller, websiteReview[1]!, { operation: "save", body: jsonBody(request) });
  const websiteProposalCreate = /^\/v1\/app\/projects\/([^/]+)\/allowed-websites\/proposals$/.exec(url.pathname);
  if (request.method === "POST" && websiteProposalCreate !== null) return projectAllowedDomainsHttp({ ...deps, ...deps.projectAllowedDomains, signInTableName: deps.developer.signInTableName }, caller, websiteProposalCreate[1]!, { operation: "propose", body: jsonBody(request) });
  const websiteProposalStatus = /^\/v1\/app\/projects\/([^/]+)\/allowed-websites\/proposals\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && websiteProposalStatus !== null) return projectAllowedDomainsHttp({ ...deps, ...deps.projectAllowedDomains, signInTableName: deps.developer.signInTableName }, caller, websiteProposalStatus[1]!, { operation: "status", proposalId: websiteProposalStatus[2]!, expectedOrgId: url.searchParams.get("expectedOrgId") });
  const websiteProposalDecision = /^\/v1\/app\/projects\/([^/]+)\/allowed-websites\/proposals\/([^/]+)\/(approve|cancel|reject)$/.exec(url.pathname);
  if (request.method === "POST" && websiteProposalDecision !== null) return projectAllowedDomainsHttp({ ...deps, ...deps.projectAllowedDomains, signInTableName: deps.developer.signInTableName }, caller, websiteProposalDecision[1]!, { operation: websiteProposalDecision[3] as "approve" | "cancel" | "reject", proposalId: websiteProposalDecision[2]!, body: jsonBody(request) });
  const websiteRequestStatus = /^\/v1\/app\/projects\/([^/]+)\/allowed-websites\/requests\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && websiteRequestStatus !== null) return projectAllowedDomainsHttp({ ...deps, ...deps.projectAllowedDomains, signInTableName: deps.developer.signInTableName }, caller, websiteRequestStatus[1]!, { operation: "request-status", requestId: websiteRequestStatus[2]!, expectedOrgId: url.searchParams.get("expectedOrgId") });
  const slackProposal = /^\/v1\/app\/projects\/([^/]+)\/slack-channel\/proposals(?:\/([^/]+)(?:\/(approve|cancel|reject))?)?$/.exec(url.pathname);
  if (slackProposal !== null) {
    let project: string;try { project = decodeURIComponent(slackProposal[1]!); } catch { throw agentXError("NOT_FOUND", "route not found"); }
    const slackDeps = { ...deps, signInTableName: deps.developer.signInTableName };
    if (request.method === "POST" && slackProposal[2] === undefined) return projectSlackBrowserHttp(slackDeps, caller, project, { operation: "propose", body: jsonBody(request) });
    if (request.method === "POST" && ["approve", "cancel", "reject"].includes(slackProposal[3] ?? "")) return projectSlackBrowserHttp(slackDeps, caller, project, { operation: slackProposal[3] as "approve" | "cancel" | "reject", proposalId: slackProposal[2]!, body: jsonBody(request) });
    if (request.method === "GET" && slackProposal[2] !== undefined && slackProposal[3] === undefined) return projectSlackBrowserHttp(slackDeps, caller, project, { operation: "proposal", expectedOrgId: url.searchParams.get("expectedOrgId"), ...(slackProposal[2] === "current" ? {} : { proposalId: slackProposal[2] }) });
    throw agentXError("NOT_FOUND", "route not found");
  }
  const slackDecisionStatus = /^\/v1\/app\/projects\/([^/]+)\/slack-channel\/decisions\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && slackDecisionStatus !== null) return projectSlackBrowserHttp({ ...deps, signInTableName: deps.developer.signInTableName }, caller, decodeURIComponent(slackDecisionStatus[1]!), { operation: "decision-status", requestId: slackDecisionStatus[2]!, expectedOrgId: url.searchParams.get("expectedOrgId") });
  const reviewedSlack = /^\/v1\/app\/projects\/([^/]+)\/slack-channel\/(links|review|unbind|requests\/([^/]+))$/.exec(url.pathname);
  if (reviewedSlack !== null) {
    let project: string;try { project = decodeURIComponent(reviewedSlack[1]!); } catch { throw agentXError("NOT_FOUND", "route not found"); }
    const slackDeps = { ...deps, signInTableName: deps.developer.signInTableName };
    const expectedOrgId = url.searchParams.get("expectedOrgId");
    if (request.method === "GET" && reviewedSlack[2] === "links") return projectSlackBrowserHttp(slackDeps, caller, project, { operation: "list", expectedOrgId, ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}) });
    if (request.method === "GET" && reviewedSlack[2] === "review") return projectSlackBrowserHttp(slackDeps, caller, project, { operation: "target", expectedOrgId, teamId: url.searchParams.get("teamId") ?? "", channelId: url.searchParams.get("channelId") ?? "" });
    if (request.method === "GET" && reviewedSlack[3] !== undefined) return projectSlackBrowserHttp(slackDeps, caller, project, { operation: "status", expectedOrgId, requestId: reviewedSlack[3] });
    if (request.method === "POST" && reviewedSlack[2] === "unbind") return projectSlackBrowserHttp(slackDeps, caller, project, { operation: "unbind", body: jsonBody(request) });
    throw agentXError("NOT_FOUND", "route not found");
  }
  const workingBranchContextRoute = /^\/v1\/app\/projects\/([^/]+)\/working-branches$/.exec(url.pathname);
  if (request.method === "POST" && workingBranchContextRoute !== null) {
    if(caller.browserSession!==true)throw agentXError("FORBIDDEN","Use a live browser session for working branch settings.");
    return projectWorkingBranchSaveHttp(deps,caller,workingBranchContextRoute[1]!,jsonBody(request));
  }
  const workingBranchStatusRoute = /^\/v1\/app\/projects\/([^/]+)\/working-branches\/requests\/([^/]+)$/.exec(url.pathname);
  if(request.method === "GET" && workingBranchStatusRoute !== null)return projectWorkingBranchSaveHttp(deps,caller,workingBranchStatusRoute[1]!,undefined,workingBranchStatusRoute[2]);
  if (request.method === "GET" && workingBranchContextRoute !== null) return readProjectWorkingBranchContextHttp(deps, caller, workingBranchContextRoute[1]!, url, request.headers);
  // Lane B: read-only branch pages; all other method/path pairs fall through.
  const workingBranchesRoute = /^\/v1\/app\/projects\/([^/]+)\/repositories\/([^/]+)\/branches$/.exec(url.pathname);
  if (request.method === "GET" && workingBranchesRoute !== null) return readProjectWorkingBranchHttp(deps, caller, workingBranchesRoute[1]!, workingBranchesRoute[2]!, url, request.headers);
  const workingBranchPreviewRoute = /^\/v1\/app\/projects\/([^/]+)\/repositories\/([^/]+)\/branches\/preview$/.exec(url.pathname);
  if (request.method === "GET" && workingBranchPreviewRoute !== null) return readProjectWorkingBranchHttp(deps, caller, workingBranchPreviewRoute[1]!, workingBranchPreviewRoute[2]!, url, request.headers, true);
  // Lane B reviewed archive: strict pinned preview + acknowledged write; legacy routes remain compatible.
  const reviewedArchiveRoute = /^\/v1\/app\/projects\/([^/]+)\/(archive-preview|reviewed-archive)$/.exec(url.pathname);
  if (reviewedArchiveRoute !== null && ((request.method === "GET" && reviewedArchiveRoute[2] === "archive-preview") || (request.method === "POST" && reviewedArchiveRoute[2] === "reviewed-archive"))) {
    let name: string;
    try { name = decodeURIComponent(reviewedArchiveRoute[1]!); } catch { throw agentXError("NOT_FOUND", "That project is unavailable in this company."); }
    if (!AgentXNameSchema.safeParse(name).success) throw agentXError("NOT_FOUND", "That project is unavailable in this company.");
    if (request.method === "GET") return readReviewedProjectArchiveAppPreview(deps, caller, name);
    return archiveProjectReviewedWithEffects({ ...deps, egress: egressDepsOf(deps), clearLearning: (orgId, project, unfinished) => clearArchivedProjectLearning(deps, orgId, project, unfinished) }, caller, name, jsonBody(request));
  }
  // Lane B reviewed restore; existing browser auth/CSRF runs before this method/path pair.
  const reviewedRestoreRoute = /^\/v1\/app\/projects\/([^/]+)\/(restore-preview|reviewed-restore)$/.exec(url.pathname);
  if (reviewedRestoreRoute !== null && ((request.method === "GET" && reviewedRestoreRoute[2] === "restore-preview") || (request.method === "POST" && reviewedRestoreRoute[2] === "reviewed-restore"))) {
    let name: string;
    try { name = decodeURIComponent(reviewedRestoreRoute[1]!); } catch { throw agentXError("NOT_FOUND", "That project is unavailable in this company."); }
    if (!AgentXNameSchema.safeParse(name).success) throw agentXError("NOT_FOUND", "That project is unavailable in this company.");
    if (request.method === "GET") return readReviewedProjectRestoreAppPreview(deps, caller, name);
    return restoreProjectReviewedWithEffects({ ...deps, egress: egressDepsOf(deps) }, caller, name, jsonBody(request));
  }
  const projectSlackChannelRoute = /^\/v1\/app\/projects\/([^/]+)\/slack-channel$/.exec(url.pathname);
  if (projectSlackChannelRoute !== null) {
    if (request.method === "PUT") return putProjectSlackChannel(deps, caller, projectSlackChannelRoute[1]!);
    if (request.method === "DELETE") return deleteProjectSlackChannel(deps, caller, projectSlackChannelRoute[1]!, jsonBody(request));
  }
  const projectArchiveRoute = /^\/v1\/app\/projects\/([^/]+)\/(archive|restore)$/.exec(url.pathname);
  if (request.method === "POST" && projectArchiveRoute !== null) return changeProjectArchive(deps, caller, projectArchiveRoute[1]!, jsonBody(request), projectArchiveRoute[2] as "archive" | "restore");
  // Meta repo lane F: the tickets that wait for a member, and the places work is asked for.
  // Test environment (wire-testenv): `/v1/app/projects/{name}/test-environment*`. Exists only while the switch is on; with it off the path falls through as any unknown path.
  const testEnvReply = await routeTestEnvironment(deps, caller, request, url, nightlyHooks({ health: testEnvStoreOf(deps) }));
  if (testEnvReply !== undefined) return testEnvReply;
  const testHealthReply = await routeTestHealth(deps, caller, request, url);
  if (testHealthReply !== undefined) return testHealthReply;
  const knownFailingPolicyReply = await routeKnownFailingPolicy(deps, caller, request, url);
  if (knownFailingPolicyReply !== undefined) return knownFailingPolicyReply;
  const setupRecipesReply = await routeSetupRecipes(deps, caller, request, url);
  if (setupRecipesReply !== undefined) return setupRecipesReply;
  const savedEnvImageReply = await routeSavedEnvImage(deps, caller, request, url);
  if (savedEnvImageReply !== undefined) return savedEnvImageReply;
  // SR-1: the task owner acknowledges that an `on` second review did not run (the merge gate). Owner only, in a browser session, audited.
  const secondReviewAck = /^\/v1\/app\/tasks\/([0-9a-f-]{36})\/second-review-acknowledge$/iu.exec(url.pathname);
  if (secondReviewAck !== null && request.method === "POST") return new StatusReply(200, await acknowledgeSecondReview(developerTaskRouteDependencies(deps, caller), caller, secondReviewAck[1]!, jsonBody(request)));
  const secondReviewReply = await routeSecondReview(deps, caller, request, url);
  if (secondReviewReply !== undefined) return secondReviewReply;
  const trackerPeopleReply = await routeTrackerPeople(deps, caller, request, url);
  if (trackerPeopleReply !== undefined) return trackerPeopleReply;
  const jiraOrgAdminReply = await routeJiraOrgAdmin(deps, caller, request, url);
  if (jiraOrgAdminReply !== undefined) return jiraOrgAdminReply;
  const knownFailingMarksReply = await routeKnownFailingMarks(deps, caller, request, url);
  if (knownFailingMarksReply !== undefined) return knownFailingMarksReply;
  const intakeReply = await routeIntake(deps, caller, request, url);
  if (intakeReply !== undefined) return intakeReply;
  const codeIntentRoute = CODE_INTENT_PATH.exec(url.pathname);
  if (request.method === "POST" && codeIntentRoute !== null) return routeCodeIntentStart(codeIntentDependenciesOf(deps, caller), caller, codeIntentRoute[1]!, jsonBody(request), request.headers);
  // Rovara Code (Plan 6 Task 19): a project's code settings. Anyone who can see the project reads them; a maintainer changes them.
  const codeSettingsRoute = /^\/v1\/app\/projects\/([^/]+)\/code-settings$/.exec(url.pathname);
  if (codeSettingsRoute !== null && (request.method === "GET" || request.method === "PUT")) {
    const settingsDeps = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, projectFor: (who: DeveloperCaller, rawName: string) => projectRoleForRoute(deps, who, rawName) };
    return request.method === "GET" ? getCodeSettings(settingsDeps, caller, codeSettingsRoute[1]!) : putCodeSettings(settingsDeps, caller, codeSettingsRoute[1]!, jsonBody(request), deps.agents);
  }
  // "How we work": the project's playbook. Anyone who can see the project reads it; a maintainer changes it.
  const playbookRoute = PLAYBOOK_PATH.exec(url.pathname);
  const playbookProcessRoute = PLAYBOOK_PROCESS_PATH.exec(url.pathname);
  if ((playbookRoute !== null && (request.method === "GET" || request.method === "PUT")) || (playbookProcessRoute !== null && request.method === "POST")) {
    const playbookDeps = {
      documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, store: deps.agents?.store, audit: deps.agents?.audit, approvals: deps.agents,
      projectFor: (who: DeveloperCaller, rawName: string) => projectRoleForRoute(deps, who, rawName),
      ...designPlaybookDeps(deps),
    };
    if (playbookProcessRoute !== null) return routeProjectProcess(playbookDeps, caller, playbookProcessRoute[1]!);
    return routeProjectPlaybook(playbookDeps, caller, request.method as "GET" | "PUT", playbookRoute![1]!, () => jsonBody(request));
  }
  // "How we work": the project's process as the tab shows it. Anyone who can see the project reads it.
  if (request.method === "POST" && url.pathname === "/v1/app/org/model-selection-policy/preview") {
    if ([...url.searchParams].length !== 0) throw agentXError("CONFIG_INVALID", "The company model-policy preview query is invalid.");
    return previewCompanyModelPolicy({documentClient:deps.documentClient,tableName:deps.tableName,now:deps.now,...(deps.agentSessions?.cursorKey===undefined?{}:{cursorKey:deps.agentSessions.cursorKey}),
      loadSnapshot:(who,name,policy)=>loadStageModelSnapshot({documentClient:deps.documentClient,tableName:deps.tableName,now:deps.now,store:deps.agents?.store,routing:deps.agents?.modelRouting??{}},who,name,undefined,undefined,policy),
    },caller,jsonBody(request));
  }
  if(request.method==="PUT"&&url.pathname==="/v1/app/org/model-selection-policy"){
    if([...url.searchParams].length!==0)throw agentXError("CONFIG_INVALID","The company model-policy query is invalid.");
    await requireCompanyModelPolicyAuthority({documentClient:deps.documentClient,tableName:deps.tableName},caller);
    if(deps.agents===undefined)throw agentXError("RUNTIME_UNAVAILABLE","Company model approvals are unavailable.");
    try {
      const result=await updateCompanyModelPolicy(deps.agents,caller,jsonBody(request));
      if(result.status==="NEEDS_CONFIRMATION")return new StatusReply(202,ModelSelectionPolicyPendingSchema.parse(result));
      return ModelSelectionPolicyAppliedSchema.parse({status:result.status,revision:result.revision,requestId:result.requestId});
    }catch(error){
      if(error instanceof CompanySameModelPolicyRefusal)return new StatusReply(403,{error:{code:error.code,reason:error.reason,fixHref:error.fixHref,message:"Company reviewer models must differ. Configure same-model exceptions per project in How we work."}});
      throw error;
    }
  }
  if (request.method === "GET" && url.pathname === "/v1/app/org/model-selection-policy") {
    if ([...url.searchParams].length !== 0) throw agentXError("CONFIG_INVALID", "The company model-policy query is invalid.");
    return getCompanyModelSelectionPolicy({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, routing: deps.agents?.modelRouting ?? {} }, caller);
  }
  // Lane C G3: the same server resolver powers the model rows and publish validation.
  const stageModelsRoute = /^\/v1\/app\/projects\/([^/]+)\/stage-models$/.exec(url.pathname);
  if (request.method === "GET" && stageModelsRoute !== null) {
    const pairs = [...url.searchParams.entries()];
    if (pairs.length > 1 || pairs.some(([key, value]) => key !== "draft" || !/^(0|[1-9][0-9]{0,9})$/u.test(value))) throw agentXError("CONFIG_INVALID", "The stage-model query is invalid.");
    const draft = url.searchParams.get("draft");
    return getStageModels({
      now: deps.now,
      projectFor: async (who, rawName) => {
        if (who.orgId !== caller.orgId || who.developerId !== caller.developerId) throw agentXError("PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_IN_APP);
        const found = await projectRoleForRoute(deps, caller, rawName);
        return { name: found.name, canEdit: projectAllows(found.role, "edit_settings") };
      },
      snapshot: (who, name, revision) => loadStageModelSnapshot({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, store: deps.agents?.store, routing: deps.agents?.modelRouting ?? {}, chatgpt: deps.chatgpt }, who, name, revision),
    }, caller, stageModelsRoute[1]!, draft === null ? {} : { draft: Number(draft) });
  }
  const howWeWorkRoute = HOW_WE_WORK_PATH.exec(url.pathname);
  if (request.method === "GET" && howWeWorkRoute !== null) {
    return getProjectHowWeWork({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, store: deps.agents?.store, projectFor: (who: DeveloperCaller, rawName: string) => projectRoleForRoute(deps, who, rawName) }, caller, howWeWorkRoute[1]!);
  }
  if (url.pathname === REVIEW_DEFAULT_NOTICE_PATH && (request.method === "GET" || request.method === "POST")) {
    const notice = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, audit: deps.agents?.audit };
    if (request.method === "GET") return readReviewDefaultNotice(notice, caller);
    if (!ReviewDefaultNoticeBodySchema.safeParse(jsonBody(request)).success) throw agentXError("CONFIG_INVALID", "body: has a field this route does not take");
    return dismissReviewDefaultNotice(notice, caller);
  }
  if (url.pathname === LEARNING_SETTINGS_PATH && (request.method === "GET" || request.method === "PUT")) {
    return routeLearningSettings({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, audit: deps.agents?.audit }, caller, request.method, () => jsonBody(request));
  }
  // v1.2 learning loop: Remember and Forget (more routes are added to learning/routes.ts by later steps).
  if (LEARNING_PATH.test(url.pathname)) {
    const projectFor = (who: DeveloperCaller, rawName: string) => projectRoleForRoute(deps, who, rawName);
    const learned = await routeLearning({
      task: developerTaskRouteDependencies(deps, caller), projectFor, audit: deps.agents?.audit,
      settings: { documentClient: deps.documentClient, tableName: deps.tableName, signInTableName: deps.developer.signInTableName, now: deps.now, ...(deps.agents?.audit === undefined ? {} : { audit: deps.agents.audit }) },
      ...(deps.agents === undefined ? {} : { decide: { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, store: deps.agents.store, audit: deps.agents.audit, approvals: deps.agents, projectFor } }),
    }, caller, request.method, url, () => jsonBody(request));
    if (learned !== undefined) return learned;
  }
  // Learning v2 L3b: the lessons and Sources tabs and the task's lessons; "what the agent loaded". Each answers undefined where the install has not wired it.
  const lessonsAnswer = await routeLessonsFor(deps, caller, request.method, url, () => jsonBody(request)) ?? await routeLoadedKnowledgeFor(deps, caller, request.method, url);
  if (lessonsAnswer !== undefined) return lessonsAnswer;
  // Team record (wire-team-record): `/v1/app/projects/{project}/record/...`, only where the record's switch is on. The org is the session's; the project role is the one the existing access check finds.
  const recordRoute = /^\/v1\/app\/projects\/([^/]+)\/record\//.exec(url.pathname);
  if (recordRoute !== null && deps.teamRecord !== undefined) {
    let projectName: string;
    try { projectName = decodeURIComponent(recordRoute[1]!); } catch { throw agentXError("PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_IN_APP); }
    const found = await projectRoleForRoute(deps, caller, projectName);
    const reply = await deps.teamRecord.routes({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), caller: { orgId: caller.orgId, developerId: caller.developerId, projectRole: found.role } });
    if (reply !== undefined) return reply.status === 200 ? reply.body : new StatusReply(reply.status, reply.body as object);
  }
  // Design review: Design first, Skip, the cost card's choices, the question card's answers, the Retry of a review that did not run, and the confirmation page of a high-risk design. A task with no design review answers as a missing one.
  if (request.method === "POST" && isDesignReviewPath(url.pathname)) return routeDesignReview(deps, caller, request, url);
  const specChoice = SPEC_CHOICE_ROUTE.exec(url.pathname);
  if (request.method === "POST" && specChoice !== null) return routeSpecChoice(deps, caller, specChoice[1]!, specChoice[2]!);
  // SH14 (switch `su`, off by default): the setup run that runs commands. With the switch off this answers undefined and the path falls through as any unknown path.
  const setupAgentReply = await routeSetupAgent(deps, caller, request, url);
  if (setupAgentReply !== undefined) return setupAgentReply;
  const setupDraftRoute = /^\/v1\/app\/projects\/([^/]+)\/setup-draft(\/apply)?$/.exec(url.pathname);
  if (setupDraftRoute !== null) {
    const drafting = setupDraftDepsOf(deps);
    if (request.method === "POST" && setupDraftRoute[2] === undefined) return startSetupDraft(drafting, caller, setupDraftRoute[1]!, jsonBody(request));
    if (request.method === "GET" && setupDraftRoute[2] === undefined) return getSetupDraft(drafting, caller, setupDraftRoute[1]!);
    if (request.method === "POST" && setupDraftRoute[2] !== undefined) return applySetupDraft(drafting, caller, setupDraftRoute[1]!, jsonBody(request));
  }
  const projectSetupCheckRoute = /^\/v1\/app\/projects\/([^/]+)\/setup-check$/.exec(url.pathname);
  if (request.method === "POST" && projectSetupCheckRoute !== null) return startProjectSetupCheck(deps, caller, projectSetupCheckRoute[1]!, jsonBody(request));
  if (request.method === "POST" && url.pathname === "/v1/app/github/connect") {
    if (deps.githubConnect === undefined) throw agentXError("NOT_FOUND", "connecting GitHub is not set up in this deployment");
    return deps.githubConnect.start(caller);
  }
  if (request.method === "GET" && url.pathname === "/v1/app/github/requests") {
    if (deps.githubConnect === undefined) throw agentXError("NOT_FOUND", "connecting GitHub is not set up in this deployment");
    return deps.githubConnect.listRequests(caller);
  }
  if (request.method === "GET" && url.pathname === "/v1/app/github/installations") {
    if (deps.githubConnect === undefined) throw agentXError("NOT_FOUND", "connecting GitHub is not set up in this deployment");
    return deps.githubConnect.listInstallations(caller);
  }
  const githubInstallationRoute = /^\/v1\/app\/github\/installations\/([1-9][0-9]{0,14})$/.exec(url.pathname);
  if (request.method === "DELETE" && githubInstallationRoute !== null) {
    if (deps.githubConnect === undefined) throw agentXError("NOT_FOUND", "connecting GitHub is not set up in this deployment");
    return deps.githubConnect.disconnect(caller, Number(githubInstallationRoute[1]));
  }
  if (request.method === "GET" && url.pathname === "/v1/app/github/repositories") return listGithubRepositories(deps, caller, url.searchParams.get("installation"));
  const githubRequestRoute = /^\/v1\/app\/github\/requests\/([0-9]{1,20})$/.exec(url.pathname);
  if (request.method === "DELETE" && githubRequestRoute !== null) {
    if (deps.githubConnect === undefined) throw agentXError("NOT_FOUND", "connecting GitHub is not set up in this deployment");
    return deps.githubConnect.cancelRequest(caller, githubRequestRoute[1]!);
  }
  if (request.method === "POST" && (url.pathname === "/v1/app/projects" || url.pathname === "/v1/dev/projects")) return createProject(deps, caller, jsonBody(request));
  if (request.method === "GET" && url.pathname === "/v1/dev/workspaces") return listWorkspaces(deps, caller);
  if (request.method === "PATCH" && url.pathname === "/v1/app/org") {
    if (caller.orgRole !== "owner") throw agentXError("FORBIDDEN", "only an owner can rename the organization");
    if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
    const parsed = RenameOrganizationBodySchema.safeParse(jsonBody(request));
    if (!parsed.success) throw bodyError(parsed.error);
    await deps.orgs.renameOrg({ ...parsed.data, orgId: caller.orgId, developerId: caller.developerId });
    return getOrganization(deps, caller);
  }
  if (request.method === "GET" && (url.pathname === "/v1/dev/org" || url.pathname === "/v1/app/org")) return getOrganization(deps, caller);
  if (request.method === "GET" && url.pathname === "/v1/app/org/invites") return listOrganizationInvites(deps, caller, url);
  const spendingEditing = /^\/v1\/app\/org\/task-stop-policy(?:\/projects\/([^/]+))?(?:\/(editing|decisions))?$/.exec(url.pathname);
  if (spendingEditing !== null) {
    const project = spendingEditing[1] === undefined ? undefined : decodeURIComponent(spendingEditing[1]);
    if (request.method === "GET" && spendingEditing[2] === "editing") return getTaskStopEditing(deps, caller, project);
    if (request.method === "PUT" && spendingEditing[2] === undefined) return writeTaskStopEditing(deps, caller, project, jsonBody(request));
    if (request.method === "POST" && spendingEditing[2] === "decisions") return writeTaskStopEditing(deps, caller, project, jsonBody(request), true);
  }
  // Lane A G1: no policy write, default inference or paid-start permission.
  if (request.method === "GET" && url.pathname === "/v1/app/org/task-stop-ceiling") return getTaskStopCeiling(deps, caller);
  if (request.method === "GET" && url.pathname === "/v1/app/org/task-stop-policy") return getTaskStopCompany(deps, caller);
  const taskStopAgentPath = /^\/v1\/app\/org\/task-stop-policy\/agents\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && taskStopAgentPath !== null) return getTaskStopAgent(deps, caller, taskStopAgentPath[1]!);
  const taskStopProjectPath = /^\/v1\/app\/org\/task-stop-policy\/projects\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && taskStopProjectPath !== null) return getTaskStopProject(deps, caller, taskStopProjectPath[1]!);
  // Lane A: current-org, live-role monthly settings projection.
  if (request.method === "GET" && url.pathname === "/v1/app/org/budget-settings") return getAdminBudgetSettings(deps, caller);
  // Lane A: reviewed creation and actor-bound historical recovery, isolated from legacy onboarding.
  if (request.method === "POST" && url.pathname === "/v1/app/org/invites/reviewed") return createReviewedOrganizationInvite(deps, caller, jsonBody(request));
  const createReceipt = /^\/v1\/app\/org\/invites\/requests\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && createReceipt !== null) return getInviteCreationReceipt(deps, caller, createReceipt[1]!);
  // Lane A: explicit canonical review/recovery for the invite write flow.
  const inviteStatus = /^\/v1\/app\/org\/invites\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && inviteStatus !== null) return getOrganizationInviteStatus(deps, caller, inviteStatus[1]!);
  const revokeInvite = /^\/v1\/app\/org\/invites\/([^/]+)\/revoke$/.exec(url.pathname);
  if (request.method === "POST" && revokeInvite !== null) return revokeOrganizationInvite(deps, caller, revokeInvite[1]!, jsonBody(request));
  if (request.method === "POST" && (url.pathname === "/v1/dev/org/invites" || url.pathname === "/v1/app/org/invites")) return createOrganizationInvite(deps, caller, jsonBody(request));
  // Lane C17: metadata-only Slack association evidence; scope comes only from the authenticated caller.
  if (request.method === "GET" && url.pathname === "/v1/app/org/service-status") return readOrgServiceStatus({ documentClient: deps.documentClient, tableName: deps.tableName, signInTableName: deps.developer.signInTableName, now: deps.now, ...deps.serviceStatus }, caller, { expectedOrgId: url.searchParams.get("expectedOrgId") });
  if (request.method === "GET" && url.pathname === "/v1/app/org/slack-workspace-evidence") {
    if (url.search !== "" || (request.body !== undefined && request.body.trim() !== "")) throw agentXError("CONFIG_INVALID", "Slack workspace evidence accepts no query parameters or body.");
    return readSlackWorkspaceEvidence(deps, caller);
  }
  if (request.method === "GET" && url.pathname === "/v1/app/org/members") return listOrganizationMembers(deps, caller);
  if (request.method === "POST" && url.pathname === "/v1/app/org/members/lookup") return lookupOrganizationMember(deps, caller, jsonBody(request));
  if (request.method === "POST" && url.pathname === "/v1/app/org/leave") return leaveOrganization(deps, caller, jsonBody(request));
  if (request.method === "PUT" && url.pathname === "/v1/app/me/name") return setMyName(deps, caller, jsonBody(request));
  const identityRoute = /^\/v1\/app\/me\/identities\/([a-z]{1,16})$/.exec(url.pathname);
  if (identityRoute !== null && request.method === "DELETE") return unlinkAppIdentity(deps, caller, identityRoute[1]!);
  if (identityRoute !== null && request.method === "POST") return startAppIdentityLink(deps, caller, identityRoute[1]!);
  // Member removal (v1.1): a preview of what moves and what ends, the removal with a receipt per request id, and its status.
  const removalPreview = /^\/v1\/app\/org\/members\/([a-f0-9]{64})\/removal-preview$/.exec(url.pathname);
  if (removalPreview !== null && request.method === "GET") return previewMemberRemoval(deps, caller, removalPreview[1]!, url);
  const removalStart = /^\/v1\/app\/org\/members\/([a-f0-9]{64})\/removal$/.exec(url.pathname);
  if (removalStart !== null && request.method === "POST") return startMemberRemovalRoute(deps, caller, removalStart[1]!, jsonBody(request), removalHelpers(deps), deps.cloud === true);
  const removalStatus = /^\/v1\/app\/org\/removals\/([^/]+)$/.exec(url.pathname);
  if (removalStatus !== null && request.method === "GET") return getMemberRemoval(deps, caller, removalStatus[1]!);
  const memberRoute = /^\/v1\/app\/org\/members\/([a-f0-9]{64})(\/role)?$/.exec(url.pathname);
  if (memberRoute !== null && request.method === "PUT" && memberRoute[2] !== undefined) {
    const body = jsonBody(request);
    // Only the trusted cookie adapter supplies authenticated; headers/body cannot opt into legacy authority.
    if (authenticated !== undefined && !OrgMemberRoleChangeBodySchema.required({ expectedRole: true }).safeParse(body).success) throw agentXError("CONFIG_INVALID", "Review a valid company role change before submitting.");
    return changeMemberRole(deps, caller, memberRoute[1]!, body);
  }
  if (memberRoute !== null && request.method === "DELETE" && memberRoute[2] === undefined) return removeOrganizationMember(deps, caller, memberRoute[1]!);
  if (request.method === "GET" && url.pathname === "/v1/dev/budget") return getBudget(deps, caller);
  if (request.method === "PUT" && url.pathname === "/v1/dev/org/budget") return putOrganizationBudget(deps, caller, jsonBody(request));
  if (url.pathname === "/v1/dev/tasks" || url.pathname.startsWith("/v1/dev/tasks/")) {
    if (deps.tasks === undefined) throw agentXError("NOT_FOUND", "developer tasks are not set up in this deployment");
    // An AI tool's start of an older version of an agent that is less safe than the current one waits for the agent's owner (owner decision 2026-10-22), as the app route's does.
    const waitingForOwner = request.method === "POST" && url.pathname === "/v1/dev/tasks" ? await gateDeveloperStart(deps, caller, request) : undefined;
    if (waitingForOwner !== undefined) return waitingForOwner;
    // Rovara Code (Plan 6): a client that does not send `x-agentx-task-view: 2` reads a version 1 projection of any task in the answer.
    return taskResponseForClient(await routeDeveloperTaskRequest(developerTaskRouteDependencies(deps, caller), caller, request, url), request.headers);
  }
  if (url.pathname === CHATGPT_CONNECTION_PATH || url.pathname === `${CHATGPT_CONNECTION_PATH}/finish`) {
    return routeChatGptConnection(deps, caller, request, url);
  }
  // The audit log: the org is the session's, and owners and admins only (the route checks the role before it says anything else).
  if (isAuditOrgPath(url.pathname)) {
    // Starting an export (the whole log in one file) needs a fresh sign-in; the role check comes first, so a caller who may not read the log is told that, not asked to sign in again.
    if (startsAuditExport(request.method, url.pathname) && canReadAuditLog(caller.orgRole)) await requireFreshSignInForExport(deps, caller);
    const reply = await routeAuditRequest(deps.auditLedger, { developerId: caller.developerId, orgId: caller.orgId, orgRole: caller.orgRole },
      { method: request.method, body: request.method === "POST" ? jsonBody(request) : {}, requestId: request.requestId }, url);
    return reply.status === 200 ? reply.body : new StatusReply(reply.status, reply.body);
  }
  throw agentXError("NOT_FOUND", "route not found");
}
