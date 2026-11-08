// split-by: scripts/split/split-broker.ts (the broker's modules are in ./broker/; broker.ts composes them and builds the Lambda handler)
// split-modules: definitions, scope-helpers, dependency-wiring, handler, workspace-routes, project-registration, workspace-preparation, thread-workspaces, task-operations, model-access, acceptance, slack-workflow-events, callbacks, evidence-and-setup, workflow-e2e-verification, feedback-and-codebuild, pull-request-reconcile, terminal-and-github-events, sweeps-and-readiness, dispatch, e2e-rounds, workflow-items, plan-answers, terminal-result, records, admin-and-helpers, runtime-clients

// First of all the imports, so that it runs before any module below can read the environment: puts back the names the control plane passes as one variable
// (AGENTX_NAMES), and what an environment's name decides, under the variables this file has always read (broker-environment.ts).
// tests/contract/broker-environment-first.test.ts keeps it first and fails on any read of a packed name before it runs.
import "./broker-environment-init.js";
import { readOwnChosenName } from "../developer/chosen-name.js";
// The file's own imports, in their old order (after the environment init), so every dependency loads as it did before the split.
import "../model-selection/evidence.js";
import "../agents/table-writes.js";
import "../org/task-stop-funding.js";
import "../org/task-stop-unpriced.js";
import "../org/task-stop-bootstrap.js";
import "../org/native-snapshot-conditions.js";
import "./service-status-runtime.js";
import "../model-selection/turn-authority.js";
import "../model-selection/turn-fallback.js";
import "../model-selection/turn-policy.js";
import "../model-selection/process-refusal.js";
import "@agentx/contracts";
import "../model-selection/selection-write.js";
import "../org/project-members.js";
import "../model-selection/fallback-request.js";
import "../model-selection/task-failures.js";
import "../model-selection/task-references.js";
import "../model-selection/fallback-record.js";
import "../model-selection/task-live.js";
import "../learning/capture-pr.js";
import "../org/project-allowed-domains.js";
import "../org/second-person-evidence.js";
import "../org/legacy-domain-narrowing.js";
import "../org/project-domain-initial.js";
import "../org/allowed-domain-policy.js";
import "../org/approval-membership.js";
import "../org/task-stop-window.js";
import "../org/project-working-branch-provider.js";
import "./task-web.js";
import "../developer/confirm-page.js";
import "./web-auth.js";
import "../developer/app-csrf.js";
import "node:crypto";
import "node:path";
import "./cancel-callback-capability.js";
import "@aws-sdk/client-cloudwatch";
import "@aws-sdk/client-dynamodb";
import "@aws-sdk/client-kms";
import "@aws-sdk/client-lambda";
import "@aws-sdk/lib-dynamodb";
import "@aws-sdk/client-s3";
import "@aws-sdk/client-sesv2";
import "@aws-sdk/client-sfn";
import "@aws-sdk/client-ssm";
import "@aws-sdk/client-sqs";
import "@aws-sdk/client-route53resolver";
import "@aws-sdk/client-secrets-manager";
import "@aws-sdk/client-sts";
import "@agentx/verifier";
import "../e2e-presentation.js";
import "./workflow-e2e-artifacts.js";
import "./baseline-source.js";
import "./workflow-e2e-baseline.js";
import "./workflow-e2e-replay.js";
import "./admin-reads.js";
import "./admin-change-audit.js";
import "./admin-changes.js";
import "zod";
import "./health-probes.js";
import "../audit/drain.js";
import "../audit/export-wiring.js";
import "../learning/cleanup.js";
import "../learning/home-source.js";
import "../intake/home-source.js";
import "../lessons/home-source.js";
import "../learning/settle.js";
import "../audit/admin-routes.js";
import "../audit/view-page.js";
import "../audit/keyring.js";
import "../audit/outbox.js";
import "../audit/flush.js";
import "../audit/events.js";
import "../audit/plan3-hooks.js";
import "../playbook/project-settings-audit.js";
import "./operation-events.js";
import "./failed-preparation.js";
import "./slack-thread-key.js";
import "./setup-check-close.js";
import "../org/request-records.js";
import "./failed-cancel-release.js";
import "../authorization.js";
import "../github-app.js";
import "./github-credentials.js";
import "./github-webhooks.js";
import "@agentx/gateway";
import "@agentx/model-runtime/catalog";
import { proxyGeographyForRegion, type ProxyGeography } from "@agentx/model-runtime/catalog";
import "@agentx/model-runtime/thinking-levels";
import "../github-mcp.js";
import "./connector-ledger.js";
import "./connector-metrics.js";
import "./connector-routes.js";
import "./connector-types.js";
import "./credentials.js";
import "../developer/verify-token.js";
import "../developer/chosen-name.js";
import "../developer/store.js";
import "../developer/person-name.js";
import "../org/github-connection.js";
import "../org/github-install-requests.js";
import "../developer/identity-notice.js";
import "../org/trial.js";
import "./github-install-web.js";
import "../developer/owner-answers.js";
import "../developer/page-comments.js";
import "../developer/plan-artifacts.js";
import "../rovara-code/ci-checks.js";
import "../rovara-code/milestones.js";
import "../rovara-code/answered.js";
import "../rovara-code/explicit-path.js";
import "../rovara-code/question-answers.js";
import "../rovara-code/merged.js";
import "../rovara-code/merged-state.js";
import "../rovara-code/outcome-hooks.js";
import "../rovara-code/linear-close.js";
import "../rovara-code/proof-inputs.js";
import "../rovara-code/proof-keep.js";
import "../rovara-code/pull-request-body.js";
import "../rovara-code/session-bindings.js";
import "../rovara-code/duration.js";
import "../rovara-code/parallel-parts.js";
import "../rovara-code/v2-switch.js";
import "../developer/plan-evidence-jobs.js";
import "../developer/plan-evidence.js";
import "../developer/workflow-actions.js";
import "./slack-refusals.js";
import "../developer/pull-request-feedback-section.js";
import "../org/cloud-projects.js";
import "../org/resolve.js";
import "../org/store.js";
import "../org/sign-in.js";
import "../org/slack-binding.js";
import "../org/egress-domains.js";
import "./egress-domains-sync.js";
import "./project-records.js";
import "./project-setup-runtime-catalog.js";
import "./project-setup-terminal-conditions.js";
import "./project-setup-capability.js";
import "../e2e/project-setup-source-smoke.js";
import "../e2e/feature-plan-intent.js";
import "./e2e-feature-verifier-catalog.js";
import "./runtime-installation.js";
import "./e2e-runtime-readiness.js";
import "./e2e-account-registry.js";
import "../e2e/application-account-registry.js";
import "./workflow-e2e-current-authority.js";
import "./workflow-e2e-notifier-projection.js";
import "./cancellation.js";
import "../developer/creator-member.js";
import "../agents/run-engine.js";
import "../agents/task-end.js";
import "../agent-sessions/index.js";
import "./agent-run-wakeup.js";
import "../agents/roster.js";
import "../developer/project-roles.js";
import "../developer/task-records.js";
import "../developer/limits.js";
import "./broker-shared.js";
import "../e2e/feature-plan-planning-context.js";
import "../e2e/feature-plan-executable-kinds.js";
import "../e2e/application-plan-approval.js";
import "../e2e/portable-feature-intent.js";
import "../e2e/owner-sentences.js";
import "../e2e/requalify-hold.js";
import "../e2e/application-dispatch-check.js";
import "../e2e/application-admission.js";
import "./workflow-e2e-grounding.js";
import "../developer/plan-grounding-findings.js";
import "../e2e/model-budget-endpoint.js";
import "../e2e/model-checks.js";
import "../e2e/model-route-registry.js";
import "../e2e/application-evidence.js";
import "./admin-actions.js";
import "../chatgpt/task-model.js";
import "../chatgpt/settings.js";
import "../model-sources/store.js";
import "../model-sources/sweep.js";
import "./slack-chatgpt.js";
import "../chatgpt/connections.js";
import "../connections/org-secrets.js";
import "../connections/registry.js";
import "./cloudwatch-connector-type.js";
import "../connections/endpoint-check.js";
import "../connections/pinned-endpoint.js";
import "./datadog-connector-type.js";
import "./grafana-connector-type.js";
import "./pagerduty-connector-type.js";
import "./sentry-connector-type.js";
import "./vercel-connector-type.js";
import "../connections/store.js";
import "../triggers/hooks.js";
import "../triggers/ingress.js";
import "../triggers/providers/index.js";
import "../chatgpt/oauth.js";
import "../model-proxy/invoker.js";
import "../org/budget.js";
import "../spend/admission.js";
import "../spend/ledger.js";
import "../spend/payer.js";
import "../spend/settlement-job.js";
import "../agents/approvals.js";
import "../agents/lifecycle.js";
import "../spend/estimate.js";
import "../spend/settings.js";
import "../agents/store.js";
import "../agents/skills.js";
import "../agents/access.js";
import "../spend/requests.js";
import "../chains/store.js";
import "../triggers/store.js";
import "../triggers/schedules.js";
import "@aws-sdk/client-scheduler";
import "../triggers/dispatch.js";
import "../triggers/github-events.js";
import "../triggers/lifecycle.js";
import "../chains/index.js";
import "../chains/lifecycle.js";
import "../chains/runner.js";
import "../chains/session-seam.js";
import "../agent-sessions/access.js";
import "../agent-sessions/events.js";
import "../agent-sessions/sweep.js";
import "../realtime/sink.js";
import "../agents/runs.js";
import "../agents/agent-tools-routes.js";
import "../agents/write-gate.js";
import "../agents/run-cache.js";
import "../developer/requester-text.js";
import "../rovara-code/critic.js";
import "../rovara-code/reviewer-model.js";
import "../rovara-code/review-model-lines.js";
import "../agents/dispatch.js";
import "@agentx/model-runtime/config";
import "../model-sources/routing.js";
import { bedrockAvailabilityProbe, newBedrockClient } from "../model-sources/bedrock-availability.js";
import { createUsableModels } from "../model-sources/usable-models.js";
import "../agents/guardrails.js";
import "../developer/decide-session.js";
import "../developer/decide-inspect.js";
import "../agents/approval-decide-kind.js";
import "./decide-web.js";
import "./json-reply.js";
import "./developer-routes.js";
import "./developer-tasks.js";
import "./workflow-dependencies-configuration.js";
import "../developer/plan-quality.js";
import "../developer/plan-dry-run-results.js";
import "../developer/plan-check-summary.js";
import "./workflow-autofix-runner.js";
import "../developer/plan-self-check.js";
import "./candidate-build-source.js";
import "./workflow-merge-recovery.js";
import "../rovara-code/merge-tracking.js";
import "../rovara-code/merge.js";
import "../rovara-code/ci-fix.js";
import "../rovara-code/branch-sync.js";
import "../rovara-code/feedback-autonomy.js";
import "../rovara-code/github-members.js";
import "../rovara-code/tracking-events.js";
import "./registration-preflight.js";
import "./turns.js";
import "../codebuild.js";
import "../repository-access.js";
import "../workspaces.js";
import "./sessions.js";
import "./stuck-setup.js";
import "./outbox-failure.js";
import "./workflow-cancel-reconcile.js";
import "./workflow-autofix-dispatch-exhaust.js";
import "./lambda.js";
import "./swebench.js";
import "./eval-batch.js";
import "./eval-batch-service.js";
import "./eval-batch-admin.js";
import "./swebench-settings.js";
import "./slack-workflow-caller.js";
import "../rovara-code/intent.js";
import "../rovara-code/setup-draft.js";
import "../developer/task-access.js";
import "../developer/task-people.js";
import { createHmac } from "node:crypto";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { StartExecutionCommand } from "@aws-sdk/client-sfn";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { savedEnvBaseImageDigestReader } from "./broker/saved-env-real.js";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { Route53ResolverClient } from "@aws-sdk/client-route53resolver";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { STSClient } from "@aws-sdk/client-sts";
import { AUDIT_SDK_REQUEST_TIMEOUT_MS, E2E_DEFAULT_MODEL_ROUTE_ID, cloudwatchRoleAccount, getParametersInBatches } from "@agentx/contracts";
import { healthProbes } from "./health-probes.js";
import type { AuditExportClientDeps } from "../audit/export.js";
import { exportInvoker, exportLinkSigner, exportPurger } from "../audit/export-wiring.js";
import type { AuditEraseDeps } from "../audit/erase.js";
import { AuditKeyring } from "../audit/keyring.js";
import type { AuditRuntime } from "../audit/outbox.js";
import { createGitHubAppCredentials } from "./github-credentials.js";
import { secretsManagerSource } from "./credentials.js";
import { developerTokenVerifier } from "../developer/verify-token.js";
import { installationBindingCheck } from "../org/github-connection.js";
import type { SlackRequestQueue } from "../developer/page-comments.js";
import type { PlanEvidenceEvent } from "../developer/plan-evidence-jobs.js";
import { cloudProjectDefaultsFromEnvironment } from "../org/cloud-projects.js";
import { installEnvironmentName, orgResolverFromEnvironment } from "../org/resolve.js";
import { syncCellAllowList } from "./egress-domains-sync.js";
import { e2eAgentInstallationFromParameters, readE2EModelRouteShape } from "../e2e/model-route-registry.js";
import { chatGptConnections, kmsChatGptSealer } from "../chatgpt/connections.js";
import { OrgSecrets, type SecretsClient } from "../connections/org-secrets.js";
import { awsCloudWatchAccess } from "./cloudwatch-connector-type.js";
import { mcpEndpointGuard } from "../connections/pinned-endpoint.js";
import { HookSecretStore, type OrgConnectionDeps } from "../connections/store.js";
import { chatGptHostId } from "../chatgpt/oauth.js";
import { ModelAccessInvoker } from "../model-proxy/invoker.js";
import { createChainScheduler, createDeadLetters, scheduleSettingsFromEnvironment } from "../triggers/schedules.js";
import { SchedulerClient } from "@aws-sdk/client-scheduler";
import { channelByNameThroughLambda, channelInfoThroughLambda, channelMembersThroughLambda, developerKeysThroughLambda, endDeveloperSessionsThroughLambda, eraseDeveloperNameThroughLambda, startIdentityLinkThroughLambda, unlinkIdentityThroughLambda, realtimeTokenThroughLambda, slackAuthCheckThroughLambda, slackUserByEmailThroughLambda, taskChannelPeopleThroughLambda, taskPeopleDisplayReadThroughLambda, taskPersonProofThroughLambda, type DeveloperApiConfiguration } from "./developer-routes.js";
import { createDeveloperApiConfiguration } from "./workflow-dependencies-configuration.js";
import { autofixConfigFromEnvironment } from "./workflow-autofix-runner.js";
import { createCodeBuildGateway } from "../codebuild.js";
import { RepositoryGrantService } from "../repository-access.js";
import { requiredEnvironment } from "./lambda.js";
import { swebenchDeploymentFromParameters } from "./swebench-settings.js";
import { positiveInteger } from "./broker/admin-and-helpers.js";
import { orgStoreOf } from "./broker/dependency-wiring.js";
import { createAwsBrokerHandler } from "./broker/handler.js";
import { registryTokenSource } from "./broker/registry-tokens-wiring.js";
import { createEditionGuard, editionBackupName, editionRecordName, installEditionPolicy, ssmEditionRecordReader } from "./broker/edition-wiring.js";
import { createBrokerPlugins } from "./broker/plugin-wiring.js";
import { portCredentialResolver } from "./broker/credential-exchange.js";
import { ssoStoresFor } from "../developer/sso-sign-in.js";
import { awsClientConfiguration, documentClient, ec2Sessions, stepFunctions } from "./broker/runtime-clients.js";
import { learningEraseHook, learningWalkDeps } from "../learning/cleanup.js";
import { DeveloperSignInStore } from "../developer/store.js";
import { createTeamRecordRuntime } from "../team-record/runtime.js";
import { channelClassThroughLambda, channelListThroughLambda, memberChannelsThroughLambda } from "./developer-routes/identity-lambda.js";
import { connectedTrackersOf } from "../team-record/tracker-connections.js";
import { linearWriteOf } from "../rovara-code/linear-write.js";
import { companyDomainsPort } from "../org/company-domains/port.js";
import { deadLetterUrlOf, opsQueueUrlOf, sqsDeadLetters, sqsOpsQueue } from "../team-record/ops-queue.js";
import { askAliasHashKey } from "../agent-sessions/ask-erased-aliases.js";
import { createEvidenceErase } from "../rovara-code/evidence-erase.js";
import { personErasureStep } from "./broker/evidence-wiring.js";
import { nameEraserOf } from "../developer/erase-name.js";
import { recordAuditSinkOf, removalFallbackThroughLambda, slackLinksOf } from "./broker/team-record-wiring.js";
export { PROJECT_SETUP_CAPTURE_POLICY, WEB_ROUTE_KEY } from "./broker/definitions.js";
export type { RegisteredProjectRecord, AwsBrokerInput } from "./broker/definitions.js";
export { swebenchDependencies } from "./broker/admin-and-helpers.js";
export { createDeveloperTaskActions, createAgentRouteDependencies, createAgentRunStarter, createCodeIntentDependencies, createCodeIntentStarter, uninstallChainRunner, createPlanDependencies } from "./broker/dependency-wiring.js";
export { AI_NAVIGATION_NOT_ON_CLOUD, requireAgentRouteStillCurrent, startPlanGroundingRound, finishPlanGrounding } from "./broker/e2e-rounds.js";
export { ownerCallerOf, feedbackCriticOwnerNotes } from "./broker/feedback-and-codebuild.js";
export { createAwsBrokerHandler } from "./broker/handler.js";
export { automaticRunStarterOf, createAutomaticRunStarter } from "./broker/nightly-run-wiring.js";
export { registerProjectFor } from "./broker/project-registration.js";
export { resolveProjectModel, requireProjectAuthority } from "./broker/records.js";
export type { ModelSourceBrokerOptions } from "./broker/scope-helpers.js";
export { isSlackTaskPeopleReadEvent, isSlackTaskPeopleChangeEvent, isSlackTaskPeopleTakeOwnershipEvent, isSlackTaskPeopleConfirmEvent, isSlackTaskAuthorizationEvent, isSlackWorkflowStartEvent, isSlackWorkflowDecisionEvent, isSlackWorkflowRetryEvent, isSlackWorkflowSendBackEvent, isSlackWorkflowResolveFindingsEvent, isSlackWorkflowCloseEvent, workflowApplicationRouteDependencies, isSlackWorkflowReviewRetryEvent, isSlackWorkflowPublishRetryEvent, isSlackWorkflowKeepPullRequestsEvent, isSlackWorkflowFeedbackFindingsDecisionEvent, isSlackWorkflowFeedbackNoteEvent, isSlackWorkflowFeedbackReviewRetryEvent, isSlackThreadNoteEvent, mayAnswerFromSlack, isSlackStopTaskEvent } from "./broker/slack-workflow-events.js";
export type { SlackStopTaskEvent, SlackWorkflowStartEvent, SlackWorkflowDecisionEvent, SlackWorkflowRetryEvent, SlackWorkflowSendBackEvent, SlackWorkflowResolveFindingsEvent, SlackWorkflowCloseEvent, SlackWorkflowReviewRetryEvent, SlackWorkflowFeedbackFindingsDecisionEvent, SlackWorkflowFeedbackNoteEvent, SlackTaskAuthorizationEvent, SlackTaskPeopleConfirmEvent, SlackTaskPeopleReadEvent, SlackTaskPeopleChangeEvent, SlackTaskPeopleTakeOwnershipEvent, SlackWorkflowPublishRetryEvent, SlackWorkflowKeepPullRequestsEvent, SlackWorkflowFeedbackReviewRetryEvent, SlackThreadNoteEvent } from "./broker/slack-workflow-events.js";
export { orgRoleAuthorityCheck, requireWorkflowE2ECreatorAuthority } from "./broker/sweeps-and-readiness.js";
export { agentStepsOfferedToPlanner } from "./broker/task-operations.js";
export { processGithubWorkflowEvent, reconcileWorkflowTrackingTask, reconcileWorkflowMergeRecoveryTask, retryGithubWebhookAsAdministrator } from "./broker/terminal-and-github-events.js";
export { workflowE2ECurrentAuthorityIsValid, settleGroundingRound, workflowE2EApplicationAuthorityIsValid, workflowE2ECreatorAuthorityProof, loadWorkflowE2EScenarioResults, loadWorkflowE2EArtifact, loadWorkflowE2EPresentation, loadWorkflowE2EPublicationChecks } from "./broker/workflow-e2e-verification.js";
export type { WorkflowE2EVerificationDiagnostic } from "./broker/workflow-e2e-verification.js";
export { connectorTypeContext } from "./broker/workspace-routes.js";

const s3 = new S3Client(awsClientConfiguration);
const secretsManager = new SecretsManagerClient(awsClientConfiguration);
// Plan 3, ruling R62: a cloud org's connection secrets are read and written only in a ConnectorSecretsRole session tagged
// with the org (OrgSecrets assumes it per org). Set only where the control plane created that role.
const connectorSecretsRoleArn = process.env.CONNECTOR_SECRETS_ROLE_ARN;
// The account this deployment runs in, from the ConnectorSecretsRole's own ARN: a CloudWatch connection may not name a role in it (Plan 4 Task 16).
const cloudwatchSts = new STSClient(awsClientConfiguration);
const ownAccountId = connectorSecretsRoleArn === undefined ? undefined : cloudwatchRoleAccount(connectorSecretsRoleArn);
const orgConnections: OrgConnectionDeps | undefined = connectorSecretsRoleArn === undefined || connectorSecretsRoleArn === "" ? undefined : {
  ownAccountId,
  documentClient,
  tableName: requiredEnvironment("STATE_TABLE_NAME"),
  env: installEnvironmentName(),
  now: Date.now,
  secrets: new OrgSecrets({
    env: installEnvironmentName(),
    roleArn: connectorSecretsRoleArn,
    sts: new STSClient(awsClientConfiguration),
    secretsFor: (credentials): SecretsClient => {
      const client = new SecretsManagerClient({ ...awsClientConfiguration, credentials });
      return { send: (command) => client.send(command as never) as Promise<{ SecretString?: string; ARN?: string; VersionId?: string; DeletedDate?: Date }> };
    },
  }),
};
const codeBuild = createCodeBuildGateway(awsClientConfiguration);

const ssm = new SSMClient(awsClientConfiguration);

const cloudOrgResolver = orgResolverFromEnvironment(process.env, orgStoreOf({ documentClient, tableName: requiredEnvironment("STATE_TABLE_NAME") }));
// Plan 2, Task 15: on a cloud install every token for an org is minted only while that org's GitHub connection holds the installation.
const github = createGitHubAppCredentials(
  secretsManager,
  cloudOrgResolver === undefined ? undefined : { requireInstallationBound: installationBindingCheck({ documentClient, tableName: requiredEnvironment("STATE_TABLE_NAME") }) },
);
const githubCredentials = github.provider;
// Enterprise foundations E2: the edition is the deploy stamp, read once; no stamp (an install deployed before editions) is no policy, never Enterprise.
const editionPolicy = installEditionPolicy(process.env, cloudOrgResolver !== undefined);
const registryTokens = registryTokenSource(awsClientConfiguration);
// Enterprise foundations P4: GitHub is the first code host and check runner plug-in; the router is what consumers move to (tasks P5a-e).
const plugins = createBrokerPlugins({ provider: githubCredentials, credentialRef: requiredEnvironment("GITHUB_APP_CREDENTIAL_REF"), codeBuild, webhookSecret: github.webhookSecret, ...(editionPolicy === undefined ? {} : { policy: editionPolicy }) });
const repositoryGrantSigningKey = createHmac("sha256", requiredEnvironment("CALLBACK_SIGNING_KEY"))
  .update("agentx:repository-grants:v3")
  .digest();
const repositoryGrants = new RepositoryGrantService(
  repositoryGrantSigningKey,
  // Enterprise foundations N-3: the credential comes from the repository's code host and must pass workerGitCredentialUsable before a worker gets it.
  portCredentialResolver({ codeHost: plugins.codeHost, credentialRef: requiredEnvironment("GITHUB_APP_CREDENTIAL_REF") }),
  // P8: the credential kinds the repository's host can hand out, written into each grant only when one needs a worker feature (an ssh key), so the dispatcher can refuse an older worker early.
  (hostKind) => plugins.codeHost.forKind(hostKind).capabilities.credentialKinds,
);

const lambdaClient = new LambdaClient(awsClientConfiguration);
/** Set only in named environments with developer sign-in (infra/lib/developer-signin.ts). */
function developerConfiguration(inviteTaskPerson?: DeveloperApiConfiguration["inviteTaskPerson"]): DeveloperApiConfiguration | undefined {
  return createDeveloperApiConfiguration(process.env, (issuer, functionName, previousIssuer) => ({
    // Spec 061 slice 2: "Ask AgentX to reply to this comment" queues on the Slack service's request queue; set only where that service runs.
    ...(process.env.SLACK_REQUEST_QUEUE_URL ? { slackRequestQueue: slackRequestQueue(process.env.SLACK_REQUEST_QUEUE_URL) } : {}),
    channelMembers: channelMembersThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    taskPersonProof: taskPersonProofThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    taskChannelPeople: taskChannelPeopleThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    taskPeopleDisplayRead: taskPeopleDisplayReadThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    channelInfo: channelInfoThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    channelClass: channelClassThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    channelList: channelListThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    memberChannels: memberChannelsThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    slackUserByEmail: slackUserByEmailThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    slackAuthCheck: slackAuthCheckThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    endDeveloperSessions: endDeveloperSessionsThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    eraseDeveloperName: eraseDeveloperNameThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    erasedNameKey: askAliasHashKey(requiredEnvironment("CALLBACK_SIGNING_KEY")),
    unlinkIdentity: unlinkIdentityThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    startIdentityLink: startIdentityLinkThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    channelByName: channelByNameThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    // Plan 5 Task 8: the realtime token is signed by DeveloperIdentity, which holds the key; the endpoint is where clients connect (set only where there is an events API).
    realtimeToken: realtimeTokenThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
    ...(process.env.REALTIME_HTTP_ENDPOINT ? { realtimeEndpoint: process.env.REALTIME_HTTP_ENDPOINT } : {}),
    // D17: kept for the Lambda's lifetime; an unknown kid refetches at most once a minute.
    verifyAccessToken: developerTokenVerifier({
      issuer,
      ...(previousIssuer === undefined ? {} : { previousIssuer }),
      keys: developerKeysThroughLambda((payload) => lambdaClient.send(new InvokeCommand({ FunctionName: functionName, Payload: payload }))),
      now: Date.now,
    }),
  }), inviteTaskPerson);
}
/** The Slack request queue (FIFO) as "Ask AgentX to reply to this comment" sends to it. */
function slackRequestQueue(queueUrl: string): SlackRequestQueue {
  const client = new SQSClient(awsClientConfiguration);
  return {
    async send(message) {
      await client.send(new SendMessageCommand({
        QueueUrl: queueUrl, MessageBody: message.body, MessageGroupId: message.groupId, MessageDeduplicationId: message.deduplicationId, MessageAttributes: message.attributes,
      }));
    },
  };
}
const developer = developerConfiguration();
const cloudProjectDefaults = cloudProjectDefaultsFromEnvironment(process.env);

const bedrockTrustPrincipals = (process.env.MODEL_SOURCE_TRUST_PRINCIPALS ?? "").split(",").map((arn) => arn.trim()).filter((arn) => arn !== "");

// Sign in with ChatGPT (#338): set only where the control plane has the connection key.
const chatGptKeyArn = process.env.CHATGPT_CONNECTION_KEY_ARN;
const chatgpt = chatGptKeyArn === undefined || chatGptKeyArn === "" ? undefined : chatGptConnections({
  documentClient, tableName: requiredEnvironment("STATE_TABLE_NAME"), fetch, now: Date.now,
  sealer: kmsChatGptSealer(new KMSClient(awsClientConfiguration), chatGptKeyArn),
  // The key is this install's own, so its ARN names the install to OpenAI.
  hostId: chatGptHostId(chatGptKeyArn),
});

// Rulings R26 and R28: set only in a named environment, where the control plane has a model proxy and the VPC-attached
// function that mints its keys. The broker never holds the proxy's master key.
const modelAccessFunctionName = process.env.MODEL_ACCESS_FUNCTION_NAME;
const modelProxyUrl = process.env.MODEL_PROXY_URL;
const modelAccess = modelAccessFunctionName === undefined || modelAccessFunctionName === "" || modelProxyUrl === undefined || modelProxyUrl === ""
  ? undefined
  : { access: new ModelAccessInvoker({ functionName: modelAccessFunctionName, lambda: lambdaClient }), proxyUrl: modelProxyUrl };
// Owner decision 2026-11-03: which of Rovara's catalog models this account cannot call (not enabled in Amazon Bedrock). Learned from a probe of the account's model availability (the broker role's one
// `bedrock:GetFoundationModelAvailability` grant, at most once every ten minutes) and from refused calls. Only where the install runs the model proxy; nothing here refuses a model somebody chose.
const usableModels = (() => {
  if (modelAccess === undefined) return undefined;
  let geography: ProxyGeography;
  try { geography = proxyGeographyForRegion(process.env.AWS_REGION ?? "us-east-1"); } catch { return undefined; }
  return createUsableModels({ documentClient, tableName: requiredEnvironment("STATE_TABLE_NAME"), now: Date.now, geography, probe: bedrockAvailabilityProbe(newBedrockClient(process.env.AWS_REGION)) });
})();

// Spec 025 A13: the health route's probes (health-probes.ts); clients are called only per request.
const cloudWatch = new CloudWatchClient(awsClientConfiguration);
const sqs = new SQSClient(awsClientConfiguration);
const scheduleSettings = scheduleSettingsFromEnvironment(process.env);

// The Audit Ledger's outbox (Task 6): set only where the control plane has the intake queue (named environments). Its
// clients give up quickly (AUDIT_SDK_REQUEST_TIMEOUT_MS, two attempts) so that auditing can never hold an action for
// long; the action's own writes use the broker's ordinary client.
const auditQueueUrl = process.env.AUDIT_INTAKE_QUEUE_URL;
const auditClientConfiguration = { ...awsClientConfiguration, maxAttempts: 2, requestHandler: { requestTimeout: AUDIT_SDK_REQUEST_TIMEOUT_MS, connectionTimeout: AUDIT_SDK_REQUEST_TIMEOUT_MS } };
const audit: AuditRuntime | undefined = auditQueueUrl === undefined || auditQueueUrl === "" ? undefined : {
  sqs: new SQSClient(auditClientConfiguration),
  queueUrl: auditQueueUrl,
  documentClient: DynamoDBDocumentClient.from(new DynamoDBClient(auditClientConfiguration), { marshallOptions: { removeUndefinedValues: true } }),
  tableName: requiredEnvironment("STATE_TABLE_NAME"),
  now: Date.now,
  log: (entry) => console.log(JSON.stringify({ component: "broker", ...entry })),
};

// The Audit Ledger's reader and export client (Task 11): named environments only. The broker reads the ledger, the seals and the keys
// tables (the key is the vault key's ARN) and writes none of them; it starts an export by invoking the export function
// asynchronously, and signs the download link for a finished one. The export function (audit/export-handler.ts) builds it.
const auditLedgerTable = process.env.AUDIT_LEDGER_TABLE_NAME;
const auditLedger: AuditExportClientDeps | undefined = auditLedgerTable === undefined || auditLedgerTable === "" ? undefined : {
  documentClient,
  ledgerTable: auditLedgerTable,
  sealsTable: requiredEnvironment("AUDIT_SEALS_TABLE_NAME"),
  keyring: new AuditKeyring({ documentClient, keysTable: requiredEnvironment("AUDIT_KEYS_TABLE_NAME"), kms: new KMSClient(awsClientConfiguration), keyId: requiredEnvironment("AUDIT_VAULT_KEY_ARN"), now: Date.now }),
  exportsBucket: requiredEnvironment("AUDIT_EXPORTS_BUCKET_NAME"),
  tableName: requiredEnvironment("STATE_TABLE_NAME"),
  ...(audit === undefined ? {} : { audit }),
  now: Date.now,
  log: (entry) => console.log(JSON.stringify({ component: "broker", ...entry })),
  invokeExport: exportInvoker(lambdaClient, requiredEnvironment("AUDIT_EXPORT_FUNCTION_NAME")),
  presign: exportLinkSigner(s3),
};

// Team record (wire-team-record): `undefined` unless the install was deployed with the record's switch on (TEAM_RECORD_ENABLED is exactly "1"). With it off nothing below is built or called.
// ERASE-NAME-1: the name a person chose and the one their sign-in record holds, erased with them whether or not the record's switch is on.
const personNameEraser = nameEraserOf({ documentClient, stateTable: requiredEnvironment("STATE_TABLE_NAME"), ...(developer?.eraseDeveloperName === undefined ? {} : { eraseSignInName: developer.eraseDeveloperName }), now: Date.now });
const recordOpsQueueUrl = opsQueueUrlOf(process.env);
const recordDeadLetterUrl = deadLetterUrlOf(process.env);
const teamRecord = createTeamRecordRuntime({ env: process.env, documentClient, ...(developer === undefined ? {} : { ...slackLinksOf(new DeveloperSignInStore({ documentClient, tableName: developer.signInTableName, nameTableName: requiredEnvironment("STATE_TABLE_NAME"), now: Date.now })) , namesOf: async (developerId: string) => { const [record, chosen] = await Promise.all([new DeveloperSignInStore({ documentClient, tableName: developer.signInTableName, now: Date.now }).getDeveloper(developerId), readOwnChosenName(documentClient, requiredEnvironment("STATE_TABLE_NAME"), developerId)]); return [...(record === undefined ? [] : [record.displayName]), ...(chosen === undefined ? [] : [chosen])]; } }), askAliasKey: askAliasHashKey(requiredEnvironment("CALLBACK_SIGNING_KEY")), nameErasure: personNameEraser, ...(recordOpsQueueUrl === undefined ? {} : { opsQueue: sqsOpsQueue(sqs, recordOpsQueueUrl) }), ...(recordDeadLetterUrl === undefined ? {} : { deadLetters: sqsDeadLetters(sqs, recordDeadLetterUrl) }), ...(process.env.AWS_LAMBDA_FUNCTION_NAME === undefined ? {} : { removalFallback: removalFallbackThroughLambda((request) => lambdaClient.send(new InvokeCommand({ FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME!, ...request }))) }), stateTableName: requiredEnvironment("STATE_TABLE_NAME"), verifiedDomains: companyDomainsPort({ documentClient, tableName: requiredEnvironment("STATE_TABLE_NAME") }), ...(orgConnections === undefined ? {} : { trackers: connectedTrackersOf({ deps: orgConnections }) }), ...(recordAuditSinkOf(audit, documentClient) === undefined ? {} : { audit: recordAuditSinkOf(audit, documentClient)! }), log: (entry) => console.log(JSON.stringify({ ...entry })) });

// Proof and evidence (wire-proof fix round 1): a person's erase also deletes the stored evidence of the tasks they created or own (not behind the proof switch).
const personEvidenceErase = createEvidenceErase({ s3, artifactBucketName: requiredEnvironment("ARTIFACT_BUCKET_NAME"), documentClient, tableName: requiredEnvironment("STATE_TABLE_NAME") });

// Erasing a person's details (Task 15): the tombstone goes in the keys table with the audit.subject_erased event, in one transaction made
// with the broker's own client; the export files are deleted by the export function (its role holds that grant), which the broker asks.
const auditErase: AuditEraseDeps | undefined = auditLedger === undefined ? undefined : {
  documentClient,
  keysTable: requiredEnvironment("AUDIT_KEYS_TABLE_NAME"),
  tableName: requiredEnvironment("STATE_TABLE_NAME"),
  ...(audit === undefined ? {} : { audit }),
  now: Date.now,
  log: (entry) => console.log(JSON.stringify({ component: "broker", ...entry })),
  purgeExports: exportPurger(lambdaClient, requiredEnvironment("AUDIT_EXPORT_FUNCTION_NAME")),
  // v1.2 learning loop: a person's erase clears their corrections' text and the suggestions that hold their words, in every project of the company; the Team record (where its switch is on) deletes their rows, facts, lessons and lake rows in the same request.
  eraseLearning: learningEraseHook(learningWalkDeps({ documentClient, tableName: requiredEnvironment("STATE_TABLE_NAME"), now: Date.now, audit }), undefined, personErasureStep(teamRecord, personEvidenceErase, personNameEraser)),
};

const githubNoticeSender = process.env.DEVELOPER_NOTICE_EMAIL_FROM ?? "";

// Plan 2, Task 19: set only on Rovara Cloud, where the foundation's DNS firewall has a "ProjectAllowList" for the approved egress domains.
// Absent, a change reports that it will apply within 5 minutes and the scheduled run (which needs the list too) is not created.
const projectAllowListId = process.env.AGENT_PROJECT_ALLOW_LIST_ID;
const egressDomainsSync = projectAllowListId === undefined || projectAllowListId === ""
  ? undefined
  : () => syncCellAllowList({ documentClient, tableName: requiredEnvironment("STATE_TABLE_NAME"), resolver: new Route53ResolverClient(awsClientConfiguration), listId: projectAllowListId, now: () => new Date() });

// Enterprise foundations I1: the group mapping and break-glass stores, built once (only where the edition has company sign-in).
const ssoStores = ssoStoresFor({ documentClient, tableName: requiredEnvironment("STATE_TABLE_NAME"), policy: editionPolicy, ...(audit === undefined ? {} : { audit }) });

export const handler = createAwsBrokerHandler({
  documentClient,
  ...(teamRecord === undefined ? {} : { teamRecord }),
  ...(audit === undefined ? {} : { audit }),
  ...(auditLedger === undefined ? {} : { auditLedger }),
  ...(auditErase === undefined ? {} : { auditErase }),
  s3,
  tableName: requiredEnvironment("STATE_TABLE_NAME"),
  artifactBucketName: requiredEnvironment("ARTIFACT_BUCKET_NAME"),
  issuer: requiredEnvironment("OIDC_ISSUER"),
  adminClaim: process.env.ADMIN_CLAIM ?? "cognito:groups",
  adminValues: JSON.parse(process.env.ADMIN_VALUES ?? "[\"agentx-admin\"]") as string[],
  callbackSigningKey: requiredEnvironment("CALLBACK_SIGNING_KEY"),
  repositoryGrants,
  githubPullRequests: githubCredentials,
  // Saved project images: the base image the project's commands run in is the worker image, named by its digest from the worker settings (aws/broker/saved-env-real.ts). Without a settings prefix, or with an image that is a tag, there is none and no key.
  ...(process.env.AGENTX_E2E_AGENT_SETTINGS_PREFIX ? { savedEnvBaseImageDigest: savedEnvBaseImageDigestReader((names) => getParametersInBatches(names, (batch) => ssm.send(new GetParametersCommand({ Names: batch }))), requiredEnvironment("AGENTX_E2E_AGENT_SETTINGS_PREFIX")) } : {}),
  codeHost: plugins.codeHost, checkRunner: plugins.checkRunner,
  projectSetupSource: { capture: ({ repositoryUrl, ref }, scope) => githubCredentials.captureE2ESourceSnapshot(repositoryUrl, ref, scope) },
  ...(process.env.AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID
    ? { projectSetupRuntimeCatalogId: process.env.AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID }
    : {}),
  ...(process.env.AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID
    ? { e2eFeatureRuntimeCatalogId: process.env.AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID }
    : {}),
  githubWebhookSecret: github.webhookSecret,
  // Plan 2, Task 14: the sender and region are the cloud sign-in's SES identity (empty: no sender, no notice).
  ...(githubNoticeSender === "" ? {} : {
    githubConnectedNotice: {
      ses: new SESv2Client(process.env.DEVELOPER_NOTICE_EMAIL_REGION || process.env.AWS_REGION ? { region: process.env.DEVELOPER_NOTICE_EMAIL_REGION || process.env.AWS_REGION as string } : {}),
      from: githubNoticeSender,
      log: (entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry })),
    },
  }),
  checkRepositoryAccess: (repository, scope) => githubCredentials.checkRepository(repository, scope),
  githubMcp: { credentials: (repository, access, scope) => githubCredentials.issueCredentials(repository, access, scope) },
  connectorCredentials: {
    secrets: secretsManagerSource(secretsManager, process.env.CONNECTOR_SECRET_PREFIX),
    githubApp: { ref: requiredEnvironment("GITHUB_APP_CREDENTIAL_REF"), secretName: github.privateKeySecretArn },
    ...(process.env.CONNECTOR_SECRET_PREFIX ? { connectorSecretPrefix: process.env.CONNECTOR_SECRET_PREFIX } : {}),
  },
  codeBuild,
  // Spec 061: set only where the PlanEvidence function exists (infra/lib/control-plane.ts).
  ...(process.env.PLAN_SELF_CHECK_ENABLED === "false" ? { planSelfCheck: false } : {}),
  autofix: autofixConfigFromEnvironment(process.env),
  ...(process.env.PLAN_EVIDENCE_FUNCTION_NAME
    ? { startPlanEvidenceJob: async (event: PlanEvidenceEvent) => {
        const response = await lambdaClient.send(new InvokeCommand({ FunctionName: process.env.PLAN_EVIDENCE_FUNCTION_NAME, InvocationType: "Event", Payload: Buffer.from(JSON.stringify(event)) }));
        if (response.StatusCode !== 202) throw new Error(`plan evidence start answered ${String(response.StatusCode)}`);
      } }
    : {}),
  ...(developer ? { developer } : {}),
  // Plan 3: the agent routes (`/v1/app/agents*`), on the real project members; they need the developer sign-in.
  // Rovara's roles that assume a Bedrock source's role (Task 24b), for the trust policy the sources page shows; unset until the control plane names them.
  // Plan 4 Task 6: the deployed broker listens for the end and the pause of a chain step's task (a test harness leaves it off, so Plan 3's own tests see no listener).
  // Plan 4 Task 19: event hooks keep their secrets in the org's own tagged secrets (Plan 3's HookSecretStore). What starts the work an event asks for is Task 20's, and until it is
  // wired a delivery is answered 503: nothing a vendor sends is accepted and lost.
  ...(developer ? { agents: {
    registerChainRunner: true,
    ...(bedrockTrustPrincipals.length === 0 ? {} : { modelSources: { bedrockTrustPrincipals } }),
    ...(orgConnections === undefined ? {} : { eventHooks: { secrets: new HookSecretStore({ env: orgConnections.env, secrets: orgConnections.secrets }) } }),
    // Plan 4 Task 26: schedule triggers, where the control plane named the schedule role and the dead-letter queue (a named environment).
    ...(scheduleSettings === undefined ? {} : {
      triggerSchedules: createChainScheduler({ client: new SchedulerClient(awsClientConfiguration), settings: scheduleSettings }),
      scheduleDeadLetters: createDeadLetters({ sqs, queueUrl: scheduleSettings.queueUrl }),
    }),
  } } : {}),
  // Plan 3, Task 21a-wiring: the confirmation page and the decide routes exist on a cloud install with the developer sign-in (the grants on the sign-in
  // table's DECIDE_ keys are cloud only). Hard gate before any deploy: Task 37 confirms Cognito's `amr` first.
  ...(developer && cloudOrgResolver !== undefined ? { decide: {} } : {}),
  ...(chatgpt ? { chatgpt } : {}),
  ...(modelAccess ? { modelAccess } : {}),
  ...(usableModels === undefined ? {} : { usableModels }),
  ...(egressDomainsSync === undefined ? {} : { egressDomainsSync }),
  cloud: cloudOrgResolver !== undefined,
  // Enterprise foundations E2: the edition is the deploy stamp, read once; no stamp (an install deployed before editions) is no policy, never Enterprise.
  ...(editionPolicy === undefined ? {} : { editionPolicy }),
  // N9 (INTG2): a project's registry tokens, only where the install switch is on.
  ...(registryTokens === undefined ? {} : { registryTokens }),
  ...(ssoStores === undefined ? {} : { sso: ssoStores }),
  // Enterprise foundations I-2: the stamp is checked against the install's retained edition record before the first request.
  editionGuard: createEditionGuard({ stamp: editionPolicy?.edition, recordName: process.env.AGENTX_ENV ? editionRecordName(installEnvironmentName()) : undefined, backupName: process.env.AGENTX_ENV ? editionBackupName(installEnvironmentName()) : undefined, read: ssmEditionRecordReader(ssm), log: (entry) => console.log(JSON.stringify({ component: "broker", ...entry })) }),
  // Task 12b's acceptance item: on Rovara Cloud every request to a company's MCP endpoint is checked again and connects only to what was checked.
  ...(cloudOrgResolver === undefined ? {} : { mcpEndpointGuard: mcpEndpointGuard() }),
  ...(orgConnections === undefined ? {} : { orgConnections }),
  // Lane ask-linear: an Ask's answer on a Linear issue is posted through the org's Linear connection (read_write only).
  ...(orgConnections === undefined ? {} : { linearReply: linearWriteOf({ deps: orgConnections }) }),
  // Plan 4 Task 16: on the hosted cloud, where the control plane grants the cross-account assume, the CloudWatch connector assumes a customer's role through STS.
  ...(cloudOrgResolver === undefined || orgConnections === undefined ? {} : { cloudwatchConnector: awsCloudWatchAccess({ ownAccountId, sts: { send: (command) => cloudwatchSts.send(command as never) } }) }),
  ...(process.env.BROKER_ROLE_ARN === undefined || process.env.BROKER_ROLE_ARN === "" ? {} : { brokerRoleArn: process.env.BROKER_ROLE_ARN }),
  // Ruling R55: a cloud org's projects run on the foundation's EC2 workers, with the built-in GitHub App.
  ...(cloudProjectDefaults === undefined ? {} : { cloudProjects: cloudProjectDefaults }),
  // Ruling R6: with the cloud sign-in configured, membership decides who has an org; operators of the admin pool have none.
  ...(cloudOrgResolver === undefined ? {} : { orgResolver: cloudOrgResolver }),
  // M1.4 Task 4.2: the installation's worker model settings (SSM, ids and ARNs only), read per request. Absent until a guarded deploy sets the prefix and grants the read, so the
  // AI navigation route cannot be derived and agent steps stay unavailable (`agent-route-not-approved`).
  ...(process.env.AGENTX_E2E_AGENT_SETTINGS_PREFIX
    ? { e2eAgentInstallation: () => e2eAgentInstallationFromParameters(requiredEnvironment("AGENTX_E2E_AGENT_SETTINGS_PREFIX"), async (names) => {
        const response = await getParametersInBatches([...names], (batch) => ssm.send(new GetParametersCommand({ Names: batch })));
        return new Map((response.Parameters ?? []).flatMap((parameter) => parameter.Name && parameter.Value ? [[parameter.Name, parameter.Value] as const] : []));
      }, process.env.AWS_REGION, { readShape: (modelId) => readE2EModelRouteShape({ documentClient, tableName: requiredEnvironment("STATE_TABLE_NAME") }, E2E_DEFAULT_MODEL_ROUTE_ID, modelId) }) }
    : {}),
  // Spec 025 A12: set only here, so a test harness without its own `me` never reaches the network.
  adminReads: {
    me: { issuer: requiredEnvironment("OIDC_ISSUER"), fetch, ...(developer?.slackUserByEmail === undefined ? {} : { slackUserByEmail: developer.slackUserByEmail }) },
    health: healthProbes({
      cloudWatch,
      sqs,
      release: process.env.AGENTX_RELEASE_VERSION,
      alarmPrefix: process.env.AGENTX_ALARM_PREFIX,
      deadLetterQueues: process.env.HEALTH_DEAD_LETTER_QUEUES,
      slackAuthCheck: developer?.slackAuthCheck,
      github: githubCredentials,
      ...(teamRecord === undefined ? {} : { teamRecordFailures: (orgId) => teamRecord.opsFailures(orgId) }),
      log: (entry) => console.log(JSON.stringify({ component: "broker", ...entry })),
    }),
  },
  ...(process.env.TURN_RECORDS_TABLE_NAME ? { turnRecordsTableName: process.env.TURN_RECORDS_TABLE_NAME } : {}),
  ...(process.env.SLACK_THREADS_TABLE_NAME ? { slackThreadsTableName: process.env.SLACK_THREADS_TABLE_NAME } : {}),
  ...(process.env.SLACK_ORCHESTRATOR_ROLE_ARN
    ? {
        slack: {
          orchestratorRoleArn: process.env.SLACK_ORCHESTRATOR_ROLE_ARN,
          memberWorkspaceLimit: positiveInteger(
            Number(process.env.SLACK_MEMBER_WORKSPACE_LIMIT ?? "3"),
            "SLACK_MEMBER_WORKSPACE_LIMIT",
          ),
          organizationWorkspaceLimit: positiveInteger(
            Number(process.env.SLACK_ORGANIZATION_WORKSPACE_LIMIT ?? "20"),
            "SLACK_ORGANIZATION_WORKSPACE_LIMIT",
          ),
        },
      }
    : {}),
  async deleteEc2Session(workspaceId) {
    await ec2Sessions().deleteSession(workspaceId);
  },
  // Spec 043: read per request, so installing the eval stack or a new runner image needs no broker release.
  ...(process.env.SWEBENCH_SETTINGS_PREFIX
    ? {
        swebench: {
          deployment: () => swebenchDeploymentFromParameters(requiredEnvironment("SWEBENCH_SETTINGS_PREFIX"), async (names) => {
            const response = await getParametersInBatches(names, (batch) => ssm.send(new GetParametersCommand({ Names: batch })));
            return new Map((response.Parameters ?? []).flatMap((parameter) => parameter.Name && parameter.Value ? [[parameter.Name, parameter.Value] as const] : []));
          }),
          async startExecution(input) {
            const response = await stepFunctions.send(new StartExecutionCommand(input));
            // Spec 052 Ruling 13: recorded on the run, so the batch tick can find a dead execution.
            return { executionArn: response.executionArn };
          },
        },
      }
    : {}),
});
