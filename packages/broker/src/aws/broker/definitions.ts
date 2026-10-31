// Part of the broker (split out of ../broker.ts): limits, the setup capture policy, the record and dependency types, route keys.

import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { S3Client } from "@aws-sdk/client-s3";
import { E2EPolicySchema, type CodeBuildCheckResult, type ProjectDefinition, type SlackRequester, type ModelIdentifier, type ProjectRole, type AdminChangeOutcome, type E2ESourceSnapshot, type E2ESetupProposal, E2E_DEFAULT_MODEL_ROUTE_ID, E2E_MODEL_FREE_LIMITS, type HookSource } from "@agentx/contracts";
import { e2ePrivateTransferMaxBytes } from "@agentx/verifier";
import type { AdminReadDependencies } from "../admin-reads.js";
import type { AuditExportClientDeps } from "../../audit/export.js";
import type { AuditEraseDeps } from "../../audit/erase.js";
import type { AuditRuntime } from "../../audit/outbox.js";
import type { GitHubAppCredentialProvider, GitHubTokenScope } from "../../github-app.js";
import type { CatalogCache } from "@agentx/gateway";
import type { GitHubMcpDependencies } from "../../github-mcp.js";
import type { ScopeDiscovery } from "../connector-routes.js";
import type { ConnectorType } from "../connector-types.js";
import type { CredentialRegistry, ConnectorCredentialsConfiguration } from "../credentials.js";
import type { IdentityNoticeDependencies } from "../../developer/identity-notice.js";
import type { PlanEvidenceEvent } from "../../developer/plan-evidence-jobs.js";
import type { CloudProjectDefaults } from "../../org/cloud-projects.js";
import type { OrgResolver } from "../../org/resolve.js";
import type { EgressDomainsDependencies } from "../../org/egress-domains.js";
import { untestedRouteSentence } from "../../e2e/model-checks.js";
import { e2eAgentRoutePolicyLimits, planE2EAgentRoute, type E2EAgentInstallation, type PlannedE2EAgentRoute } from "../../e2e/model-route-registry.js";
import type { ChatGptConnections } from "../../chatgpt/connections.js";
import type { CloudWatchAws } from "../../connectors/native/cloudwatch.js";
import type { McpEndpointGuard } from "../../connections/pinned-endpoint.js";
import type { OrgConnectionDeps, OrgConnectionStoreInput } from "../../connections/store.js";
import type { ConnectedAwsAccounts, HookSecrets } from "../../triggers/hooks.js";
import type { HookIngressMemory, HookIngressDeps } from "../../triggers/ingress.js";
import type { HookProvider } from "../../triggers/providers/types.js";
import type { ModelAccess } from "../../model-proxy/access.js";
import type { AgentStoreInput } from "../../agents/store.js";
import type { ProjectMembers } from "../../agents/access.js";
import type { AgentRouteDependencies } from "../../agents/routes.js";
import type { TriggerStore } from "../../triggers/store.js";
import type { TriggerHookReader, TriggerScheduler } from "../../triggers/ports.js";
import type { ScheduleDeadLetters } from "../../triggers/schedules.js";
import type { ChainTriggerHooks } from "../../chains/routes.js";
import type { SessionAccessDependencies } from "../../agent-sessions/access.js";
import type { SessionTakeOverDependencies } from "../../agent-sessions/take-over.js";
import type { AgentToolsDependencies } from "../../agents/agent-tools-routes.js";
import type { ContextSourcesRuntime } from "../../context-sources/runtime.js";
import type { DecideKinds } from "../../developer/decide-kinds.js";
import type { DeveloperApiConfiguration } from "../developer-routes.js";
import type { AutofixConfig } from "../workflow-autofix-runner.js";
import type { TurnRecordExport } from "../turns.js";
import type { CodeBuildGateway } from "../../codebuild.js";
import type { RepositoryGrantService } from "../../repository-access.js";
import type { RuntimeBinding } from "../lambda.js";
import type { EvalBatchDependencies } from "../eval-batch.js";
import type { startPlanGroundingRound } from "./e2e-rounds.js";
import type { ModelSourceBrokerOptions } from "./scope-helpers.js";

export const MAX_ARTIFACT_BYTES = 5_000_000;
export const MAX_SETUP_PROPOSAL_BYTES = 24 * 1024 * 1024;
// This derived ceiling bounds only the chunked private carrier; each report,
// frame, literal, record, and admitted group keeps its existing component limit.
export const MAX_SETUP_EVIDENCE_BYTES = e2ePrivateTransferMaxBytes(64, 4);
export const SETUP_ARTIFACT_CHUNK_BYTES = 64 * 1024;
// 100,000 complete tree paths at the 1,024-byte path ceiling, plus the accepted 4 MiB source
// materialization (base64 expansion and bounded JSON envelope). This is a private chunked object
// ceiling, not a larger HTTP/report limit.
export const MAX_WORKFLOW_CANDIDATE_EXPORT_BYTES = 112 * 1024 * 1024;
export const WORKFLOW_CANDIDATE_CHUNK_BYTES = 64 * 1024;
export const EVENT_TRANSACTION_CHUNK = 80;

/**
 * The capture policy a new setup proposal and its approval carry (owner decision D3, as amended by Ruling CJ): screenshots of failed cases and downloads; no video, and no
 * traces (deferred past M1.3, because a Playwright trace keeps session tokens that cannot be scrubbed reliably). The executor keeps screenshots only for failed cases and
 * only inside a fixed budget (Task 3.6).
 * A project whose setup was approved earlier keeps the policy it was approved with (its stored all-false policy is read as written), so it gets screenshots only after its
 * setup is approved again. A proposal made before this default existed is no longer approvable ("propose the setup again"), though a decision already recorded for it is still
 * answered as an idempotent retry.
 */
export const PROJECT_SETUP_CAPTURE_POLICY = Object.freeze({ screenshots: true, traces: false, video: false, downloads: true });

export function projectSetupPolicy(proposal: E2ESetupProposal, agentRoute?: { revision: string; definition: { budgets: Parameters<typeof e2eAgentRoutePolicyLimits>[0] } }): ReturnType<typeof E2EPolicySchema.parse> {
  return E2EPolicySchema.parse({
    schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [], targets: proposal.targets,
    defaultSandboxProfileId: "default-sandbox", fallback: "mock-unconnected", modelRouteRevision: agentRoute?.revision ?? null,
    capture: PROJECT_SETUP_CAPTURE_POLICY,
    // A setup that pins a route runs under limits derived from the route's budgets (D2); one that pins none gets the normal limits (a build and an app start need minutes), with model budgets of one (RUN-1).
    limits: agentRoute === undefined
      ? { ...E2E_MODEL_FREE_LIMITS }
      : e2eAgentRoutePolicyLimits(agentRoute.definition.budgets),
  });
}

/**
 * The AI navigation route this installation would approve now (Task 4.2), read by key. Undefined when the installation's worker settings cannot be read or give no usable
 * route (no provider, a keyed provider without its secret, an unproven OpenRouter default): the setup is then proposed and approved without AI navigation, and agent steps stay
 * unavailable with `agent-route-not-approved`.
 */
export async function plannedAgentRoute(dependencies: Pick<AwsBrokerDependencies, "documentClient" | "tableName" | "e2eAgentInstallation">): Promise<Extract<PlannedE2EAgentRoute, { status: "available" }> | undefined> {
  if (dependencies.e2eAgentInstallation === undefined) return undefined;
  try {
    const planned = await planE2EAgentRoute({ documentClient: dependencies.documentClient, tableName: dependencies.tableName }, await dependencies.e2eAgentInstallation());
    return planned.status === "available" ? planned : undefined;
  } catch { return undefined; }
}

/**
 * What a setup proposal says when the installation's route is well-formed but has no passed driving test (Task 4.10C): the provider, the model and the sentence "AI navigation steps
 * will not run: the driving test with <provider> `<model>` has not passed (<why>)". Null when the route is available, or cannot be made at all (the CLI's own sentence says that).
 */
export async function untestedAgentRouteNote(dependencies: Pick<AwsBrokerDependencies, "documentClient" | "tableName" | "e2eAgentInstallation">): Promise<{ provider: string; modelId: string; sentence: string } | null> {
  if (dependencies.e2eAgentInstallation === undefined) return null;
  try {
    const store = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
    const planned = await planE2EAgentRoute(store, await dependencies.e2eAgentInstallation());
    if (planned.status !== "unavailable" || planned.untested === undefined) return null;
    return { provider: planned.untested.provider, modelId: planned.untested.modelId, sentence: await untestedRouteSentence(store, { ...planned.untested, routeId: E2E_DEFAULT_MODEL_ROUTE_ID }) };
  } catch { return null; }
}

export interface RegisteredProjectRecord {
  pk: string;
  sk: string;
  entityType: "PROJECT";
  definition: ProjectDefinition;
  runtimeBinding: RuntimeBinding;
  registeredBy: string;
  registeredAt: string;
  setupApproval?: { proposalRef: string; proposalSha256: string; candidateDigest: string; decision: "approve" | "decline" };
}

export interface MembershipRecord {
  pk: string;
  sk: string;
  entityType: "MEMBERSHIP";
  ownerKey: string;
  projectName: string;
  /** `developer` for a maintainer or contributor, `viewer` for a viewer (Plan 2, Task 21), `administrator` for the operator's own. */
  role: "developer" | "viewer" | "administrator";
  grantId: string;
  /** Task 21: the project role, who made the grant (a person of the org, or the operator console) and when. Rows from before it have none. */
  projectRole?: ProjectRole;
  grantedBy?: unknown;
  grantedAt?: string;
}

export interface ProjectModelSelectionRecord {
  pk: string;
  sk: "SELECTION";
  entityType: "PROJECT_MODEL_SELECTION";
  model: ModelIdentifier;
  updatedAt: string;
  updatedBy: SlackRequester | string;
}

export interface PullRequestRecord {
  pk: string;
  sk: string;
  entityType: "PULL_REQUEST";
  workspaceId: string;
  repository: string;
  repositoryUrl: string;
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  headBranch: string;
  baseBranch: string;
  expectedHeadCommit: string;
  title: string;
  body: string;
  /** Set when GitHub refused to open this pull request as a draft and it was opened as a normal one (INTG1). */
  draftRefused?: true;
  createdByOperationId: string;
  replacedBy?: number;
  replacementFor?: number;
  updatedAt: string;
}

export interface CodeBuildRecord {
  pk: string;
  sk: string;
  entityType: "CODEBUILD";
  workspaceId: string;
  operationId: string;
  fence: number;
  repository: string;
  gate: string;
  projectName: string;
  requestedSourceVersion: string;
  idempotencyToken: string;
  buildId: string;
  evidence: CodeBuildCheckResult;
  createdAt: string;
  updatedAt: string;
}

export interface AwsBrokerDependencies {
  documentClient: DynamoDBDocumentClient;
  /** The Audit Ledger's outbox (named environments only); absent on a legacy install, where every audit function does nothing. */
  audit?: AuditRuntime;
  /** What reading the Audit Ledger and starting its exports needs (Task 11); absent on a legacy install. The broker builds no export: its own function does. */
  auditLedger?: AuditExportClientDeps;
  /** What erasing a person's audit details needs (Task 15); absent on a legacy install, where the staff erase route does not exist. */
  auditErase?: AuditEraseDeps;
  s3: S3Client;
  /** Starts deleting an ec2-ebs workspace's instance and volume (#84). */
  deleteEc2Session?: (workspaceId: string) => Promise<void>;
  tableName: string;
  artifactBucketName: string;
  issuer: string;
  adminClaim: string;
  adminValues: readonly string[];
  callbackSigningKey: string;
  repositoryGrants: RepositoryGrantService;
  githubPullRequests: Pick<GitHubAppCredentialProvider, "reconcilePullRequest" | "getPullRequest" | "updatePullRequest" | "verifyWebhookRepository"> & Partial<Pick<GitHubAppCredentialProvider, "readWorkingBranchRepository" | "readWorkingBranch" | "createWorkingBranchPreviewSession" | "listWorkingBranches" | "installationForRepository" | "listInstallationRepositories" | "appSlug" | "oauthClient" | "installation" | "organizationMembership" | "authorStanding" | "getRepositoryIdentity" | "listPullRequestFiles" | "getPullRequestStatus" | "getRepositoryPermission" | "readCodeOwners" | "listChangedPaths" | "isTeamMember" | "mergePullRequest" | "getRepositoryStanding" | "replyToReviewThread" | "markPullRequestReady" | "requestReviewers" | "getJobLogTail" | "getPullRequestChangedFiles" | "getPullRequestFeedback" | "getPullRequestMergeObservation" | "getCommitTree" | "getCommitParents" | "getBranchHead" | "getDefaultBranchHead" | "getFileAtCommit" | "getAgentPullRequestHead" | "agentRepositoryReader" | "listAgentRepositoryLabels" | "createAgentInstallationToken">>;
  /** Trusted server-side source capture for setup discovery and exact-commit E2E planning context. */
  projectSetupSource?: { capture: (input: { repositoryUrl: string; ref: string }, scope: GitHubTokenScope) => Promise<E2ESourceSnapshot> };
  /** Server-selected catalog namespace for an already configured setup verifier. */
  projectSetupRuntimeCatalogId?: string;
  /** Separate server-selected namespace for the already qualified portable feature verifier. */
  e2eFeatureRuntimeCatalogId?: string;
  /** The fetch the GitHub install flow's user-token calls (github.com and api.github.com) go through; the global fetch when absent. */
  githubFetch?: typeof fetch;
  /**
   * The installation's worker model settings (provider, a keyed provider's secret ARN, the OpenRouter allowlist, the region): what the AI browser-test agent's route is derived from at
   * setup approval and again at dispatch (M1.4 Task 4.2). Absent, or throwing, the route cannot be derived and agent steps stay unavailable with `agent-route-not-approved`.
   */
  e2eAgentInstallation?: () => Promise<E2EAgentInstallation>;
  /** Reads the GitHub webhook HMAC key from the configured GitHub App secret; `refresh` asks for a fresh read of the secret. */
  githubWebhookSecret?: (options?: { refresh?: boolean }) => Promise<string>;
  /** Plan 2, Task 14: how the owners of an org are emailed when a GitHub organization is connected through a request. Absent, nobody is. */
  githubConnectedNotice?: IdentityNoticeDependencies;
  /** How long a PR description update (D2) may take before it gives up without writing; 5 seconds when absent. */
  descriptionUpdateMaxMs?: number;
  /** Refuses, with CONFIG_INVALID, a repository its credential cannot reach; checked at registration. */
  checkRepositoryAccess?: (repository: { credentialRef: string; url: string }, scope: GitHubTokenScope) => Promise<void>;
  codeBuild: CodeBuildGateway;
  slack?: SlackServiceConfiguration;
  /** Spec 025 developer sign-in; absent when the deployment has none, and /v1/dev/* answers NOT_FOUND. */
  developer?: DeveloperApiConfiguration;
  /** Sign in with ChatGPT (#338): each developer's ChatGPT connection; absent without its key. */
  chatgpt?: ChatGptConnections;
  /** The model proxy (rulings R28 and R29): mints each task's key through the VPC-attached function, and says where the proxy is. Absent without one. */
  modelAccess?: { access: ModelAccess; proxyUrl: string };
  /**
   * Ruling R42: true only on a cloud install (DEVELOPER_CLOUD_ISSUER is configured, as for the R6 resolver). Only a cloud
   * install's orgs have a trial lock and a machine-time allowance; a private install's single org is never limited.
   */
  cloud?: boolean;
  /**
   * Ruling R55: where, and with which credential, a cloud org's owner or admin creates a project (the foundation's launch template and
   * subnets, and the built-in GitHub App). Absent, POST /v1/dev/projects answers RUNTIME_UNAVAILABLE.
   */
  cloudProjects?: CloudProjectDefaults;
  /**
   * Plan 2, Task 18: pushes the approved egress domains to the cell's DNS firewall (Task 19's `syncCellAllowList`). Absent, a change waits
   * for the scheduled sync and the person who made it is told it will apply within 5 minutes.
   */
  egressDomainsSync?: EgressDomainsDependencies["sync"];
  /** Which org a caller belongs to (ruling R1). Absent means every caller belongs to the install's single org (ruling R3). */
  orgResolver?: OrgResolver;
  /**
   * Plan 3, Task 7: what the agent routes (`/v1/app/agents*`) need beyond the broker's own tables. Absent, those routes answer NOT_FOUND.
   * The store, access checks and approvals are built from the broker's State table and sign-in table. `projectMembers` (who holds which role
   * on a project) is Plan 2 Task 21's `createProjectMembers` over those same tables unless a test hands in a stand-in (PF6).
   */
  agents?: { /** Plan 4 Task 19: where event hooks keep their secrets, which providers read their deliveries and what starts the work; absent where hooks are not set up. */ eventHooks?: { secrets: HookSecrets; providers?: Partial<Record<HookSource, HookProvider>>; dispatch?: HookIngressDeps["dispatch"]; memory?: HookIngressMemory; /** Plan 4 Task 25: which AWS accounts an org connected (default: its CloudWatch connections) and the fetch under SNS certificate and confirmation requests. */ awsAccounts?: ConnectedAwsAccounts; snsFetch?: typeof fetch }; projectMembers?: ProjectMembers; resolveSkill?: AgentRouteDependencies["resolveSkill"]; servableModels?: AgentRouteDependencies["servableModels"]; /** Plan 6: whether Rovara Code version 2 is available (default off until Task 8); tests turn it on. */ rovaraCodeV2Live?: boolean; orgSourceOrder?: AgentRouteDependencies["orgSourceOrder"]; pullRequestHead?: AgentRouteDependencies["pullRequestHead"]; requestRunLimit?: AgentRouteDependencies["requestRunLimit"]; chainTriggers?: ChainTriggerHooks; triggers?: TriggerStore; hooks?: TriggerHookReader; triggerSchedules?: TriggerScheduler; /** Plan 4 Task 26: the queue that keeps the schedule invocations that failed, drained by the chain sweep. */ scheduleDeadLetters?: ScheduleDeadLetters; chainRuns?: AgentRouteDependencies["chainRuns"]; chainRunBudgets?: AgentRouteDependencies["chainRunBudgets"]; registerChainRunner?: boolean; modelSources?: ModelSourceBrokerOptions; sessions?: Pick<SessionAccessDependencies, "chainReadAccess" | "chain"> & Pick<SessionTakeOverDependencies, "chainOwner"> } & Pick<AgentStoreInput, "newId" | "builtins">;
  /**
   * Plan 3, Task 21a (R66): present, the decisions are made on the confirmation page (`/v1/app/approve/{id}`), the decide routes send a token
   * there, and the sign-in function may ask `decide-inspect`. Absent, the page answers NOT_FOUND and nothing can be decided. The `apr_` kind (write,
   * step and change approvals) is built here from the agent routes' dependencies; `kinds` adds or replaces kinds (Task 32 registers `spr_`; a test
   * hands in a stand-in).
   */
  decide?: { kinds?: DecideKinds };
  /** The install's environment name, which its single org id derives from; defaults to the developer sign-in's, then AGENTX_ENV, then "default". */
  environmentName?: string;
  /** The GitHub MCP connector's own settings, and the issuer of its tokens: told whose work each is for (Plan 2, Task 15). */
  githubMcp?: Omit<GitHubMcpDependencies, "credentials"> & {
    credentials(repository: { url: string; credentialRef: string }, access: "read" | "write", scope: GitHubTokenScope): Promise<{ owner: string; repo: string; token: string }>;
  };
  catalogs: CatalogCache<ScopeDiscovery>;
  credentialRegistry?: CredentialRegistry;
  /**
   * Plan 3, ruling R62: where a cloud org's connections and their org-tagged secrets live. On a cloud install the connector
   * types read these, for the caller's, workspace's or task's org, instead of `credentialRegistry`. Absent, a cloud org has
   * no connections at all: the install-wide registry is never used for one.
   */
  orgConnections?: OrgConnectionDeps;
  /**
   * Plan 3 Task 12b: how the connection routes reach a vendor. By default a connection is checked with `fetch`, the MCP server's tools are
   * listed over the network, and an MCP endpoint is checked with `checkEndpointUrl` and the system resolver; a test replaces any of them.
   */
  connectionChecks?: Pick<OrgConnectionStoreInput, "fetch" | "listMcpTools" | "checkEndpoint" | "endpointGuard" | "checks">;
  /** Plan 4 Task 13: a test replaces the fetch under every native connector's vendor requests; production uses the lookup-checked one. */
  nativeFetch?: typeof fetch;
  /**
   * Plan 4 Task 16: the AWS access the CloudWatch connector and its connection check assume a customer's role through. Set only on the hosted cloud, where
   * the control plane grants the broker the cross-account assume; without it a CloudWatch connection cannot be checked or read.
   */
  cloudwatchConnector?: CloudWatchAws;
  /** Plan 4 Task 16: the broker function's own role ARN, named as the principal in the trust policy a CloudWatch connection shows the customer. */
  brokerRoleArn?: string;
  /** The administrator turn record export; absent when the deployment has no TurnRecords table. */
  turnRecords?: TurnRecordExport;
  /** The TurnRecords table developer task audit records go to (spec 025); absent when there is none. */
  turnRecordsTableName?: string;
  /** Connector types this deployment serves; the built-in types when absent. */
  connectorTypes?: Record<string, ConnectorType>;
  /**
   * Plan 3 Task 19 (Task 12b's acceptance item): checks a company's MCP endpoint before every request and connects only to the addresses the check
   * returned. Set on Rovara Cloud, where the broker runs outside any VPC; absent on a private install, whose endpoints its own network rules govern.
   */
  mcpEndpointGuard?: McpEndpointGuard;
  /**
   * Plan 3 Task 19: the agent tool routes (`/v1/internal/agent-tools*`). `configure` receives the dependencies the broker builds and returns the ones to use: Task 21
   * replaces the write gate there (`gate`), and a test replaces a check or a lister with its own.
   */
  agentTools?: { configure?: (base: AgentToolsDependencies) => AgentToolsDependencies };
  /** Lane E: the MCP context sources' servers, Team record hooks and result keeper (`/v1/internal/context-tools*`). Absent: the routes answer that no sources are set up. */
  contextSources?: ContextSourcesRuntime;
  /** Spec 025 C14: the Slack threads table, read for a shared thread's waiting messages; absent in legacy. */
  slackThreadsTableName?: string;
  /** Spec 025 phase 25d: the admin read routes' injected probes and clock; the defaults serve production. */
  adminReads?: Partial<Pick<AdminReadDependencies, "me" | "health" | "now" | "log">>;
  /** Spec 025 phase 25e: the admin changes' method switch, clock and metric; the defaults serve production. */
  adminChanges?: { confirm?: { elicitation: boolean; slack: boolean }; now?: () => number; metric?: (outcome: AdminChangeOutcome) => void };
  /** Spec 061: asks the PlanEvidence job to work a plan's evidence row (an async Lambda invoke); absent when the deployment has none. */
  startPlanEvidenceJob?: (event: PlanEvidenceEvent) => Promise<void>;
  /** Plan self-check (checks every coding plan, asks the planner again once when it finds a fixable problem): on unless this is false, the installation's kill switch (the PlanSelfCheckEnabled stack parameter, a packed setting the broker reads as PLAN_SELF_CHECK_ENABLED; never a Lambda variable of its own). */
  planSelfCheck?: boolean;
  /** T7c: false turns the hold for the current-app check off (a plan is shown at once); the default is on. */
  planGrounding?: boolean;
  /** T7c: starts the held plan's check on the current app; tests replace it (the real one builds an admission from an exported source). */
  startPlanGrounding?: typeof startPlanGroundingRound;
  /** AUTOFIX: automatic fixing of blocked checks and reviews. Absent: off (the harnesses); the deployed Lambda sets it from its packed settings (the AutofixEnabled stack parameter, read as AUTOFIX_ENABLED; on unless it is false; never a Lambda variable of its own). */
  autofix?: AutofixConfig;
  /** Spec 043: SWE-bench runs; absent in a harness that does not exercise them. */
  swebench?: Pick<EvalBatchDependencies, "deployment" | "startExecution" | "stopBatchForThread" | "onRunEnded" | "now" | "estimateRunCostUsd">;
}

/**
 * What callers supply; the handler creates the per-container catalog cache when none is given, and
 * the credential registry from `connectorCredentials` unless one is injected, and the turn record
 * export from `turnRecordsTableName` unless one is injected.
 */
export type AwsBrokerInput = Omit<AwsBrokerDependencies, "catalogs"> & {
  catalogs?: CatalogCache<ScopeDiscovery>;
  connectorCredentials?: ConnectorCredentialsConfiguration;
  turnRecordsTableName?: string;
};

export interface SlackServiceConfiguration {
  orchestratorRoleArn: string;
  memberWorkspaceLimit: number;
  organizationWorkspaceLimit: number;
}

/** A "." or ".." path segment, also percent-encoded (%2e in any case). */
export const DOT_SEGMENT = /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i;
export const DEVELOPER_ROUTE_KEY = "ANY /v1/dev/{proxy+}";
/** The hosted app's routes (Plan 2): authorizer-free like /v1/dev, the broker verifies the same developer token itself. */
export const APP_ROUTE_KEY = "ANY /v1/app/{proxy+}";
export const WEB_ROUTE_KEY = "ANY /v1/web/{proxy+}";
export const FEEDBACK_REVIEW_ROUTE_KEY = "ANY /review/{proxy+}";
