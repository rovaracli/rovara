// Part of the broker (split out of ../broker.ts): environment, organisation and GitHub scope helpers, egress decisions, connection stores.

import { liveWriterRole } from "../../org/live-role.js";
import { AgentXError, agentXError, EgressApproveBodySchema, EgressRejectBodySchema, OrgIdSchema, singleOrgIdForEnv, type EgressDecisionResponse, type EgressOwner, type EgressPendingResponse, type OrgId, auditOperatorId, cloudwatchRoleAccount } from "@agentx/contracts";
import type { AuthenticatedIdentity } from "../../auth.js";
import type { z } from "zod";
import { resolveSlackThreadKey as resolveSlackThreadKeyForInstall } from "../slack-thread-key.js";
import type { GitHubTokenScope } from "../../github-app.js";
import { proxyGeographyForRegion } from "@agentx/model-runtime/catalog";
import type { GitHubMcpDependencies } from "../../github-mcp.js";
import { DeveloperSignInStore } from "../../developer/store.js";
import { installEnvironmentName, requireOrgId, singleOrgResolver, type OrgResolver } from "../../org/resolve.js";
import { OrgStore } from "../../org/store.js";
import { decideEgressDomain, listPendingEgress, type EgressDomainsDependencies } from "../../org/egress-domains.js";
import { requireProject } from "../project-records.js";
import { getItem } from "../cancellation.js";
import type { CreatorCheckDependencies } from "../../developer/creator-member.js";
import { readChatGptSettings } from "../../chatgpt/settings.js";
import { ModelSourceStore } from "../../model-sources/store.js";
import type { ModelSourceRouteDependencies } from "../../model-sources/routes.js";
import { cloudwatchConnectionCheck } from "../cloudwatch-connector-type.js";
import { dnsResolveHost, checkEndpointUrl } from "../../connections/endpoint-check.js";
import { datadogConnectionCheck } from "../datadog-connector-type.js";
import { grafanaConnectionCheck } from "../grafana-connector-type.js";
import { pagerdutyConnectionCheck } from "../pagerduty-connector-type.js";
import { sentryConnectionCheck } from "../sentry-connector-type.js";
import { vercelConnectionCheck } from "../vercel-connector-type.js";
import { OrgConnectionStore } from "../../connections/store.js";
import { HookStore, disableHooksOfAccount } from "../../triggers/hooks.js";
import { changeBudgets, type OrgBudgetSettings } from "../../org/budget.js";
import { readProjectAi } from "../../spend/settings.js";
import { spendDecideKind } from "../../spend/requests.js";
import type { AgentRouteDependencies } from "../../agents/routes.js";
import { chatGptServing, type RoutingDependencies } from "../../model-sources/routing.js";
import { DecideStore, type DecideRequestContext } from "../../developer/decide-session.js";
import { approvalDecideKind } from "../../agents/approval-decide-kind.js";
import { authenticateBearer } from "../developer-routes.js";
import { connectedAwsAccountsOf, workspaceKey } from "./admin-and-helpers.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { orgStoreOf } from "./dependency-wiring.js";
import { routeEditionDependencies } from "../../wiring/enterprise-identity.js";

/** The install's environment name: what its single org (ruling R3) and the default org resolver derive from. */
export function brokerEnvironmentName(dependencies: Pick<AwsBrokerDependencies, "environmentName" | "developer">): string {
  return dependencies.environmentName ?? dependencies.developer?.env ?? installEnvironmentName();
}

/** The org of a single-org install, for a writer or reader that has no caller and whose record names no org yet. */
export function installOrgId(dependencies: Pick<AwsBrokerDependencies, "environmentName" | "developer">): OrgId {
  return singleOrgIdForEnv(brokerEnvironmentName(dependencies));
}

/** C25 compatibility: a pre-org workspace belongs only to the checked install's single org. */
export function resolveSlackThreadKey(dependencies: AwsBrokerDependencies, orgId: OrgId, ownerKey: string) {
  return resolveSlackThreadKeyForInstall(dependencies, orgId, ownerKey, installOrgId(dependencies));
}

export function orgResolverOf(dependencies: Pick<AwsBrokerDependencies, "orgResolver" | "environmentName" | "developer">): OrgResolver {
  return dependencies.orgResolver ?? singleOrgResolver(brokerEnvironmentName(dependencies));
}

/**
 * The org a stored record belongs to: its own `orgId` once records carry one (Task 5), else the org
 * its owner belongs to. A record whose owner has no org is refused (ruling R6).
 */
export async function orgOfRecord(
  dependencies: Pick<AwsBrokerDependencies, "orgResolver" | "environmentName" | "developer">,
  record: { orgId?: unknown; ownerKey?: unknown; developerId?: unknown },
): Promise<OrgId> {
  const stored = OrgIdSchema.safeParse(record.orgId);
  if (stored.success) return stored.data;
  return requireOrgId(await orgResolverOf(dependencies)({
    ...(typeof record.ownerKey === "string" ? { ownerKey: record.ownerKey } : {}),
    ...(typeof record.developerId === "string" ? { developerId: record.developerId } : {}),
  }));
}

/**
 * Plan 2, Task 15: whose work a GitHub token is minted for. A cloud install's work belongs to an org, whose GitHub connection must hold the
 * installation at the moment of the mint (the provider checks it); anywhere else the token is the install's own (`private-install`), which has
 * no bindings. A cloud caller whose org is unknown mints nothing.
 */
export function githubScope(dependencies: Pick<AwsBrokerDependencies, "cloud">, orgId: OrgId | undefined): GitHubTokenScope {
  if (dependencies.cloud !== true) return { system: "private-install" };
  if (orgId === undefined) throw agentXError("GITHUB_NOT_CONNECTED", "Rovara can't tell which organization this GitHub access is for; sign in again and retry");
  return { orgId };
}

/** `githubScope` for a record that names its org, or an owner or developer who resolves to one (a task, a workspace). */
export async function githubScopeOf(dependencies: AwsBrokerDependencies, record: { orgId?: unknown; ownerKey?: unknown; developerId?: unknown }): Promise<GitHubTokenScope> {
  if (dependencies.cloud !== true) return { system: "private-install" };
  return { orgId: await orgOfRecord(dependencies, record) };
}

/** `githubScope` for the workspace an operation runs in. */
export async function githubScopeOfWorkspace(dependencies: AwsBrokerDependencies, workspaceId: string): Promise<GitHubTokenScope> {
  if (dependencies.cloud !== true) return { system: "private-install" };
  const item = await getItem<Record<string, unknown>>(dependencies, workspaceKey(workspaceId));
  if (item === undefined) throw agentXError("NOT_FOUND", "workspace not found");
  return githubScopeOf(dependencies, item);
}

/** The GitHub MCP settings with their token issuer bound to one scope, as the connector framework (which knows no org) calls it. */
export function githubMcpFor(mcp: NonNullable<AwsBrokerDependencies["githubMcp"]>, scope: () => Promise<GitHubTokenScope>): GitHubMcpDependencies {
  return { ...mcp, credentials: async (repository, access) => mcp.credentials(repository, access, await scope()) };
}

/**
 * Ruling R60: what the removed-creator check reads with. A task that names no org is placed by the org resolver; one whose owner has
 * no org at all is a legacy task and the check skips it.
 */
export function creatorCheckOf(dependencies: AwsBrokerDependencies): CreatorCheckDependencies {
  return {
    documentClient: dependencies.documentClient, tableName: dependencies.tableName,
    orgOf: async (task) => {
      try {
        return await orgOfRecord(dependencies, task);
      } catch (error) {
        if (error instanceof AgentXError) return undefined;
        throw error;
      }
    },
  };
}

/**
 * The repository URL a task's linked PR belongs to, for the webhook paths. A webhook has no caller and its task is
 * read by id only, so the project is read in the org the task names, else the install's single org.
 */
export function webhookRepositoryUrl(dependencies: AwsBrokerDependencies): (projectName: string, revision: number, repositoryId: string, orgId?: OrgId) => Promise<string | undefined> {
  return async (projectName, revision, repositoryId, orgId) => {
    const project = await requireProject(dependencies, orgId ?? installOrgId(dependencies), projectName, revision);
    return project.definition.repositories.find((repository) => repository.name === repositoryId)?.url;
  };
}

/**
 * A single-org install (no injected org resolver) creates its org's record lazily, before the first
 * org-scoped write (ruling R3). An install with its own resolver manages its orgs itself.
 */
export async function ensureInstallOrg(dependencies: AwsBrokerDependencies, orgId: OrgId): Promise<void> {
  if (dependencies.orgResolver !== undefined) return;
  await new OrgStore({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now })
    .ensureOrg(orgId, brokerEnvironmentName(dependencies));
}

/**
 * The existing R47 operator credential check remains authoritative on private installs.
 * Budget snapshot/revision conditions apply; operators are not company members.
 */
export async function putInstallBudget(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, body: unknown): Promise<{ budget: OrgBudgetSettings }> {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  if (dependencies.cloud === true) throw agentXError("FORBIDDEN", "organizations on this install set their own budgets; ask an owner or admin of the organization");
  const modelAccess = dependencies.modelAccess;
  if (modelAccess === undefined) throw agentXError("NOT_FOUND", "budgets are not set up in this deployment");
  const orgId = requireOrgId(identity.orgId);
  const orgs = orgStoreOf(dependencies);
  // The install's org is created on first use; an operator may set its budgets before anyone has signed in.
  await orgs.ensureOrg(orgId, brokerEnvironmentName(dependencies));
  const operator = { kind: "operator" as const, id: auditOperatorId(identity.issuer, identity.subject) };
  const budget = await changeBudgets(
    { documentClient: dependencies.documentClient, tableName: dependencies.tableName, access: modelAccess.access, orgs, ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }) },
    // The chain names an operator by a pseudonymous id, never by their identity.
    { authority: { operator }, orgId, body, updatedBy: operator.id, at: new Date().toISOString(), actor: operator },
  );
  console.log(JSON.stringify({ component: "broker", event: "admin.org_budget_changed", orgId, overrides: Object.keys(budget.memberOverrides).length }));
  return { budget };
}

/** What an install may set about company AI sources beyond the model proxy itself (Task 24b); the rest of their dependencies come from the broker's own. */
export type ModelSourceBrokerOptions = Pick<ModelSourceRouteDependencies, "launch" | "checkEndpoint" | "bedrockTrustPrincipals" | "isKnownCatalog">;

/** The company AI sources' record (Task 24b). The install-wide ChatGPT switch sets a new org's default order. */
export function modelSourceStoreOf(dependencies: AwsBrokerDependencies): ModelSourceStore {
  return new ModelSourceStore({
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now,
    // Read the way ChatGPT's own code reads it, so what a new org's order says and what the install shows agree.
    chatgptSwitch: async () => (dependencies.chatgpt === undefined
      ? await readChatGptSettings({ documentClient: dependencies.documentClient, tableName: dependencies.tableName })
      : await dependencies.chatgpt.settings()).enabled,
    ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }),
  });
}

/**
 * Task 26: what routing a step's model needs: the org's sources, the project's own order, a person's ChatGPT plan and the endpoint hosts' approvals.
 * Governed stage routing reads sources even before agents are configured; other flows retain their existing enablement.
 */
export function routingOf(dependencies: AwsBrokerDependencies, stageModel = false): RoutingDependencies | undefined {
  if ((!stageModel && dependencies.agents === undefined) || dependencies.modelAccess === undefined) return undefined;
  const settings = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
  let geography: RoutingDependencies["rovaraGeography"];
  try { geography = proxyGeographyForRegion(process.env.AWS_REGION ?? "us-east-1"); } catch { geography = undefined; }
  return {
    sources: modelSourceStoreOf(dependencies),
    egress: settings,
    projectSourceOrder: async (orgId, project) => (await readProjectAi(settings, orgId, project)).sourceOrder,
    ...(dependencies.chatgpt === undefined ? {} : { chatgpt: chatGptServing(dependencies.chatgpt) }),
    ...(dependencies.agents?.modelSources?.launch === undefined ? {} : { launch: dependencies.agents.modelSources.launch }),
    ...(geography === undefined ? {} : { rovaraGeography: geography }),
  };
}

export function egressDepsOf(dependencies: AwsBrokerDependencies): EgressDomainsDependencies {
  return {
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, cloud: dependencies.cloud === true, now: () => new Date(), sync: dependencies.egressDomainsSync ?? (async () => ({ ok: false })),
    ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }),
  };
}

/**
 * Plan 2, Task 18: `GET /v1/admin/egress/pending`. The domains waiting for Rovara staff (operators of the admin pool; on cloud they belong to
 * no org, ruling R6), from every org, oldest first, with the org's name and who asked.
 */
export async function listEgressPending(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity): Promise<EgressPendingResponse> {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  const orgs = orgStoreOf(dependencies);
  const developers = dependencies.developer === undefined ? undefined
    : new DeveloperSignInStore({ documentClient: dependencies.documentClient, tableName: dependencies.developer.signInTableName, nameTableName: dependencies.tableName, now: Date.now });
  const orgNames = new Map<string, string>();
  const people = new Map<string, string>();
  const pending: EgressPendingResponse["pending"] = [];
  for (const row of await listPendingEgress(dependencies)) {
    if (!orgNames.has(row.orgId)) orgNames.set(row.orgId, (await orgs.getOrg(row.orgId))?.name ?? "Unknown");
    if (!people.has(row.requestedBy)) people.set(row.requestedBy, (await developers?.getDeveloper(row.requestedBy))?.displayName ?? "Unknown");
    pending.push({ orgId: row.orgId, orgName: orgNames.get(row.orgId)!, owner: row.owner, domain: row.domain, requestedAt: row.requestedAt, requestedBy: { developerId: row.requestedBy, name: people.get(row.requestedBy)! } });
  }
  return { pending };
}

/**
 * Plan 2, Task 18: `POST /v1/admin/egress/approve` and `/reject`. An operator decides one pending domain of one owner of one org; the audit
 * item names the operator. A domain that is not pending (decided already, removed, or never asked for) is CONFIG_INVALID.
 */
export async function decideEgress(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, decision: "approved" | "rejected", body: unknown): Promise<EgressDecisionResponse & { warning?: string }> {
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  const parsed: z.ZodSafeParseResult<{ requestId: string; orgId: OrgId; owner: EgressOwner; domain: string; reason?: string }> = decision === "approved"
    ? EgressApproveBodySchema.safeParse(body) : EgressRejectBodySchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  const { orgId, owner, domain, reason, requestId } = parsed.data;
  const { warning } = await decideEgressDomain(egressDepsOf(dependencies), {
    orgId, owner, domain, decision, operatorId: identity.subject, requestId,
    // The chain names the staff member by a pseudonymous id, never by their identity.
    auditActor: { kind: "operator", id: auditOperatorId(identity.issuer, identity.subject) },
    ...(reason === undefined ? {} : { reason }),
  });
  return { orgId, owner, domain, status: decision, ...(warning === undefined ? {} : { warning }) };
}

/** The confirmation page's dependencies; undefined without `decide` or the developer sign-in it needs. */
export function decideRequestContext(dependencies: AwsBrokerDependencies, agents: AgentRouteDependencies | undefined): DecideRequestContext | undefined {
  const { decide, developer } = dependencies;
  if (decide === undefined || developer === undefined) return undefined;
  return {
    store: new DecideStore({ documentClient: dependencies.documentClient, tableName: developer.signInTableName, now: Date.now }),
    now: Date.now,
    // The page is served by the cell, at the origin its access tokens are issued from.
    cellOrigin: new URL(developer.issuer).origin,
    // `apr_`: write, step and change approvals, over the same dependencies as the agent routes; without them nothing is registered, so every approval is not found.
    kinds: { ...(agents === undefined ? {} : { apr: approvalDecideKind(agents), spr: spendDecideKind(agents) }), ...decide.kinds },
    authenticateBearer: (authorization) => authenticateBearer({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, developer, now: Date.now, orgs: orgStoreOf(dependencies), ...routeEditionDependencies(dependencies) }, authorization),
    // I2: an Auditor decides nothing, whatever approval still names them.
    requireWriter: async (orgId, developerId) => { await liveWriterRole({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, signInTableName: developer.signInTableName }, orgId, developerId); },
  };
}

/** The agent routes' dependencies, built once per handler; undefined without the project roles or developer sign-in they need. */
/**
 * The org connection store (Plan 3 Task 12b), on the broker's own table and audit outbox. An MCP endpoint is checked at save and before every
 * check, with the real resolver unless a test replaces it. Undefined where no connection secrets role is configured.
 */
export function orgConnectionStoreOf(dependencies: AwsBrokerDependencies): OrgConnectionStore | undefined {
  if (dependencies.orgConnections === undefined) return undefined;
  return new OrgConnectionStore({
    ...dependencies.orgConnections,
    documentClient: dependencies.documentClient,
    tableName: dependencies.tableName,
    ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }),
    checkEndpoint: async (url) => { await checkEndpointUrl(url, dnsResolveHost); },
    // Plan 4 Task 25 review M-2: a removed AWS connection turns off the org's CloudWatch hooks for its account (unless another connection still holds the account). Built when it runs,
    // because the account check reads this same store.
    ...(dependencies.agents?.eventHooks === undefined ? {} : {
      afterRemove: async (removed: { orgId: OrgId; type: string; roleArn?: string }) => {
        const awsAccounts = connectedAwsAccountsOf(dependencies);
        if (removed.type !== "cloudwatch" || removed.roleArn === undefined || awsAccounts === undefined) return;
        const account = cloudwatchRoleAccount(removed.roleArn);
        if (account === undefined) return;
        await disableHooksOfAccount({ store: new HookStore({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now }), awsAccounts }, removed.orgId, account);
      },
    }),
    // The checks of an MCP endpoint and a Grafana address go over a connection pinned to the addresses checked (the store's default guard is `mcpEndpointGuard()`).
    // Each native type's check is registered as its task lands (Plan 4 Tasks 13 to 17); a test may replace any of them through `connectionChecks.checks`.
    checks: {
      sentry: sentryConnectionCheck, datadog: datadogConnectionCheck, grafana: grafanaConnectionCheck, pagerduty: pagerdutyConnectionCheck, vercel: vercelConnectionCheck,
      ...(dependencies.cloudwatchConnector === undefined ? {} : { cloudwatch: cloudwatchConnectionCheck(dependencies.cloudwatchConnector) }),
    },
    ...dependencies.connectionChecks,
  });
}
