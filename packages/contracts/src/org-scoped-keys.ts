// Multi-tenancy: the DynamoDB keys whose names two orgs can share (a project called "web", a member
// grant on it, the workspace limits) or that list across tenants (the usage and failure indexes).
// Each one is prefixed with `orgScoped(orgId, ...)`, and nothing else builds these keys.
import { canonicalInstant, indexDay } from "./admin.js";
import type { AgentId, AgentPrincipal, ApprovalId, SkillId } from "./agent.js";
import { OrgIdSchema, orgScoped, type OrgId, type OrgKey } from "./org.js";
import { scopeKey, type BudgetScope } from "./spend.js";

const REVISION_WIDTH = 12;

/** The partition holding every revision of one project (and its selection row) in one org. */
export function projectPk(orgId: OrgId, name: string): string {
  return orgScoped(orgId, `PROJECT#${name}`);
}

const PROJECT_PK = /^ORG#(org_[0-9a-z]{20})#PROJECT#/;

/** The org a `projectPk` is scoped to, or undefined for a partition key that is not one. */
export function orgOfProjectPk(pk: string): OrgId | undefined {
  const parsed = OrgIdSchema.safeParse(PROJECT_PK.exec(pk)?.[1]);
  return parsed.success ? parsed.data : undefined;
}

export function projectRevisionKey(orgId: OrgId, name: string, revision: number): OrgKey {
  return { pk: projectPk(orgId, name), sk: `REV#${String(revision).padStart(REVISION_WIDTH, "0")}` };
}

/** The sort-key prefix of a project's revisions, for a query on `projectPk`. */
export const PROJECT_REVISION_SK_PREFIX = "REV#";

/**
 * A project's record beside its revisions: status (active or archived), description, who created it and the setup check. Absent on a
 * project registered before Plan 2, which reads as active, created by "unknown".
 */
export function projectMetaKey(orgId: OrgId, name: string): OrgKey {
  return { pk: projectPk(orgId, name), sk: "META" };
}

export function projectSelectionKey(orgId: OrgId, name: string): OrgKey {
  return { pk: projectPk(orgId, name), sk: "SELECTION" };
}

/** A project's setup approval: the proposal an administrator approved, held once per project name in one org. */
export function projectSetupApprovalKey(orgId: OrgId, projectName: string, proposalSha256: string): OrgKey {
  return { pk: orgScoped(orgId, `PROJECT_SETUP#${projectName}`), sk: `PROPOSAL#${proposalSha256}` };
}

/**
 * The value a workspace META item carries in the byWorkspaceProject index's partition attribute: the
 * project name prefixed with its org, so two orgs' same-named projects list separately.
 */
export function workspaceProjectIndexValue(orgId: OrgId, projectName: string): string {
  return orgScoped(orgId, projectName);
}

/** The index attributes a workspace META item is written with (see WORKSPACE_PROJECT_INDEX); the project is prefixed with its org. */
export function workspaceProjectIndexAttributes(workspace: { orgId: OrgId; projectName: string; createdAt: string }): {
  workspaceProject: string;
  workspaceCreatedAt: string;
} {
  return { workspaceProject: workspaceProjectIndexValue(workspace.orgId, workspace.projectName), workspaceCreatedAt: workspace.createdAt };
}

/** The partition holding one person's project grants in one org. */
export function memberGrantsPk(orgId: OrgId, ownerKey: string): string {
  return orgScoped(orgId, `MEMBER#${ownerKey}`);
}

/** The sort-key prefix of a member's grants, for a query on `memberGrantsPk`. */
export const MEMBER_GRANT_SK_PREFIX = "PROJECT#";

export function projectMemberKey(orgId: OrgId, ownerKey: string, project: string): OrgKey {
  return { pk: memberGrantsPk(orgId, ownerKey), sk: `PROJECT#${project}` };
}

export type OrgSettingName = "WORKSPACE_LIMITS" | "BUDGET" | "BUDGET_SYNCED" | "SPEND_POLICY";

export function orgSettingsKey(orgId: OrgId, name: OrgSettingName): OrgKey {
  return { pk: orgScoped(orgId, "SETTINGS"), sk: name };
}

/**
 * The marker that says what the model proxy was last told: the org's monthly limit, or, given a developer, that member's.
 * It sits beside the org's settings, so one lookup says whether an upsert is due.
 */
export function budgetSyncedKey(orgId: OrgId, developerId?: string): OrgKey {
  return developerId === undefined ? orgSettingsKey(orgId, "BUDGET_SYNCED") : { pk: orgScoped(orgId, "SETTINGS"), sk: `BUDGET_SYNCED#${developerId}` };
}

/** The partition of an org's machine-time counters (one item per UTC month) and their once-keys. */
export function machineTimePk(orgId: OrgId): string {
  return orgScoped(orgId, "MACHINE_TIME");
}

/** The seconds of EC2 compute an org used in one UTC month (`month` is `YYYY-MM`). */
export function machineTimeMonthKey(orgId: OrgId, month: string): OrgKey {
  return { pk: machineTimePk(orgId), sk: month };
}

/** The marker that makes recording one workspace's one compute stop idempotent. */
export function machineTimeOnceKey(orgId: OrgId, workspaceId: string, stoppedAt: number): OrgKey {
  return { pk: machineTimePk(orgId), sk: `ONCE#${workspaceId}#${stoppedAt}` };
}

/** The partition of an org's open-compute markers: one item per workspace whose instance is running right now. */
export function openComputePk(orgId: OrgId): string {
  return orgScoped(orgId, "OPEN_COMPUTE");
}

export function openComputeKey(orgId: OrgId, workspaceId: string): OrgKey {
  return { pk: openComputePk(orgId), sk: workspaceId };
}

/** The org-wide open-workspace counter; it replaces `DEVELOPER_LIMIT#ORGANIZATION`. */
export function orgLimitKey(orgId: OrgId): OrgKey {
  return { pk: orgScoped(orgId, "DEVELOPER_LIMIT#ORGANIZATION"), sk: "ORGANIZATION" };
}

/** One org's usage items for a UTC day (`day` is `YYYY-MM-DD`). */
export function orgUsageDayPk(orgId: OrgId, day: string): string {
  return orgScoped(orgId, `USAGE#${day}`);
}

export function orgUsageIndexKey(orgId: OrgId, at: string, opId: string): OrgKey {
  const time = canonicalInstant(at);
  return { pk: orgUsageDayPk(orgId, indexDay(time)), sk: `${time}#${opId}` };
}

/** One org's failure items for a UTC day (`day` is `YYYY-MM-DD`). */
export function orgFailureDayPk(orgId: OrgId, day: string): string {
  return orgScoped(orgId, `FAILURE#${day}`);
}

export function orgFailureIndexKey(orgId: OrgId, endedAt: string, opId: string): OrgKey {
  const time = canonicalInstant(endedAt);
  return { pk: orgFailureDayPk(orgId, indexDay(time)), sk: `${time}#${opId}` };
}

/** A3: the partition of an org's project catalog, one row per registered project. */
export function orgProjectCatalogPk(orgId: OrgId): string {
  return orgScoped(orgId, "PROJECT_CATALOG");
}

export function orgProjectCatalogKey(orgId: OrgId, name: string): OrgKey {
  return { pk: orgProjectCatalogPk(orgId), sk: `PROJECT#${name}` };
}

/** The partition holding every channel binding of one Slack team in one org. */
export function slackBindingPk(orgId: OrgId, teamId: string): string {
  return orgScoped(orgId, `SLACK_BINDING#${teamId}`);
}

/** The sort-key prefix of a team's channel bindings, for a query on `slackBindingPk`. */
export const SLACK_BINDING_SK_PREFIX = "CHANNEL#";

export function slackBindingKey(orgId: OrgId, teamId: string, channelId: string): OrgKey {
  return { pk: slackBindingPk(orgId, teamId), sk: `${SLACK_BINDING_SK_PREFIX}${channelId}` };
}

/** The partition holding the workspace counters of one Slack team in one org. */
export function slackLimitPk(orgId: OrgId, teamId: string): string {
  return orgScoped(orgId, `SLACK_LIMIT#${teamId}`);
}

/** The sort-key prefix of a team's member counters, for a query on `slackLimitPk`. */
export const SLACK_LIMIT_MEMBER_SK_PREFIX = "MEMBER#";

export function slackMemberLimitKey(orgId: OrgId, teamId: string, userId: string): OrgKey {
  return { pk: slackLimitPk(orgId, teamId), sk: `${SLACK_LIMIT_MEMBER_SK_PREFIX}${userId}` };
}

export function slackOrganizationLimitKey(orgId: OrgId, teamId: string): OrgKey {
  return { pk: slackLimitPk(orgId, teamId), sk: "ORGANIZATION" };
}

const SLACK_LIMIT_PK = /^ORG#org_[0-9a-z]{20}#SLACK_LIMIT#/;

/** Whether a partition key is a `slackLimitPk`, which decides a counter's entity type. */
export function isSlackLimitPk(pk: string): boolean {
  return SLACK_LIMIT_PK.test(pk);
}

const AGENT_VERSION_WIDTH = 6;
const MAX_AGENT_VERSION = 10 ** AGENT_VERSION_WIDTH - 1;

export type AgentItemSk = "META" | "DRAFT" | `VERSION#${string}` | `SHARE#${string}` | `EVENT#${string}`;

/** One agent's partition: its META, its DRAFT, immutable versions, shares and events. */
export function agentKey(orgId: OrgId, agentId: AgentId, sk: AgentItemSk): OrgKey {
  return { pk: orgScoped(orgId, `AGENT#${agentId}`), sk };
}

/** The sort key of a published version; six digits keep a query on `VERSION#` in version order. */
export function agentVersionSk(version: number): `VERSION#${string}` {
  if (!Number.isInteger(version) || version < 1 || version > MAX_AGENT_VERSION) throw new Error(`an agent version is a whole number from 1 to ${MAX_AGENT_VERSION}`);
  return `VERSION#${String(version).padStart(AGENT_VERSION_WIDTH, "0")}`;
}

/** The org's agent directory: one item per custom agent, for listing without reading every partition. */
export function agentDirectoryKey(orgId: OrgId, agentId: AgentId): OrgKey {
  return { pk: orgScoped(orgId, "AGENT_DIRECTORY"), sk: agentId };
}

/** The item that makes an agent's name unique in its org, ignoring case and surrounding spaces. */
export function agentNameKey(orgId: OrgId, name: string): OrgKey {
  return { pk: orgScoped(orgId, "AGENT_NAME"), sk: name.trim().toLowerCase() };
}

/** `MEMBER#<developerId>`, `PROJECT#<project>` or `ORG`: the principal's part of a key. */
export function principalKey(principal: AgentPrincipal): string {
  if (principal.kind === "member") return `MEMBER#${principal.developerId}`;
  if (principal.kind === "project") return `PROJECT#${principal.project}`;
  return "ORG";
}

/** The index item that lists, per principal, the agents shared with it. */
export function principalSharesKey(orgId: OrgId, principal: AgentPrincipal, agentId: AgentId): OrgKey {
  return { pk: orgScoped(orgId, `AGENT_SHARES#${principalKey(principal)}`), sk: agentId };
}

/** The roster item that puts an agent on a project. */
export function projectAgentKey(orgId: OrgId, project: string, agentId: AgentId): OrgKey {
  return { pk: orgScoped(orgId, `PROJECT_AGENTS#${project}`), sk: agentId };
}

export type SkillItemSk = "META" | `VERSION#${string}`;

export function skillKey(orgId: OrgId, skillId: SkillId, sk: SkillItemSk): OrgKey {
  return { pk: orgScoped(orgId, `SKILL#${skillId}`), sk };
}

/** The org's skill directory: one item per skill, for listing without reading every partition. */
export function skillDirectoryKey(orgId: OrgId, skillId: SkillId): OrgKey {
  return { pk: orgScoped(orgId, "SKILL_DIRECTORY"), sk: skillId };
}

/** The item that makes a skill's name unique in its org. A skill name is already lower case (`^[a-z0-9][a-z0-9-]{0,63}$`). */
export function skillNameKey(orgId: OrgId, name: string): OrgKey {
  return { pk: orgScoped(orgId, "SKILL_NAME"), sk: name };
}

/** The index item that lists an agent's recent tasks, newest last; `createdAt` is an instant. */
export function agentTasksKey(orgId: OrgId, agentId: AgentId, createdAt: string, taskId: string): OrgKey {
  return { pk: orgScoped(orgId, `AGENT_TASKS#${agentId}`), sk: `${canonicalInstant(createdAt)}#${taskId}` };
}

/**
 * The item that remembers one run's start (H2): one per (org, request id), written in the same transaction as the run, so a repeat of the
 * request is answered from it. The org is in the key, so another org's request with the same id is a different request.
 */
export function runRequestKey(orgId: OrgId, requestId: string): OrgKey {
  return { pk: orgScoped(orgId, `RUN_REQUEST#${requestId}`), sk: "META" };
}

/** An org's settings for one built-in agent: the version it pinned, its budget and its accountable person. */
export function builtinSettingsKey(orgId: OrgId, agentId: AgentId): OrgKey {
  return { pk: orgScoped(orgId, "BUILTIN_AGENTS"), sk: agentId };
}

/** An approval record: a pending change, a write waiting for a person, or a step waiting for one. */
export function approvalKey(orgId: OrgId, approvalId: ApprovalId): OrgKey {
  return { pk: orgScoped(orgId, `APPROVAL#${approvalId}`), sk: "META" };
}

/**
 * The global index of approvals still open, in the order they expire (ids only: the item names the org and the approval, and a
 * reader re-checks `orgId` on the record it points at). `expiresAt` is an instant.
 */
export function openApprovalKey(expiresAt: string, orgId: OrgId, approvalId: ApprovalId): OrgKey {
  return { pk: "OPEN_APPROVALS", sk: `${canonicalInstant(expiresAt)}#${orgId}#${approvalId}` };
}

/** The item that lists one approval for one person who may be asked to decide it (an id it names, or a candidate of its rule). */
export function approverIndexKey(orgId: OrgId, developerId: string, approvalId: ApprovalId): OrgKey {
  return { pk: orgScoped(orgId, `APPROVER#${developerId}`), sk: approvalId };
}

/**
 * The item that remembers what one request to change an agent did (R18): one per (org, developer, request id), written in the same
 * transaction as the change, so a repeat of the request is answered from it and writes nothing.
 */
export function agentRequestKey(orgId: OrgId, developerId: string, requestId: string): OrgKey {
  return { pk: orgScoped(orgId, `AGENT_REQUEST#${developerId}`), sk: requestId };
}

/** An org's agent guardrails: one item holding the document and its revision. */
export function agentGuardrailsKey(orgId: OrgId): OrgKey {
  return { pk: orgScoped(orgId, "AGENT_GUARDRAILS"), sk: "META" };
}

/** An org's company AI sources (Plan 3 Task 24b): one item holding the sources, their order and its revision. */
export function modelSourcesKey(orgId: OrgId): OrgKey {
  return { pk: orgScoped(orgId, "MODEL_SOURCES"), sk: "META" };
}

// ---- spend (Plan 3 Task 28): settings, top-ups, counters and the records the budget tasks keep

/** A project's AI settings: its monthly budget, who pays, its source order and planning limits. */
export function projectAiKey(orgId: OrgId, project: string): OrgKey {
  return { pk: orgScoped(orgId, `PROJECT_AI#${project}`), sk: "SETTINGS" };
}

/** What an admin added to one scope's limit for one UTC month (`month` is `YYYY-MM`): an item holding `amountUsd`, changed with ADD. */
export function topUpKey(orgId: OrgId, month: string, scope: BudgetScope): OrgKey {
  return { pk: orgScoped(orgId, `TOPUP#${month}`), sk: scopeKey(scope) };
}

/** A spend counter for one UTC month; `sk` names what is counted (`scopeKey` of its scope, or `AGENT_USAGE#<agentId>`, which has no limit). */
export function spendCounterKey(orgId: OrgId, month: string, sk: string): OrgKey {
  return { pk: orgScoped(orgId, `SPEND#${month}`), sk };
}

/** The once-per-month marker that a budget alert was sent: `scope` is a `scopeKey`, `level` how far along the budget is. */
export function budgetAlertKey(orgId: OrgId, month: string, scope: string, level: string): OrgKey {
  return { pk: orgScoped(orgId, `BUDGET_ALERT#${month}`), sk: `${scope}#${level}` };
}

/** What the broker knows of a key it minted at the model proxy, by the key's id. */
export function modelKeyKey(orgId: OrgId, keyId: string): OrgKey {
  return { pk: orgScoped(orgId, `MODEL_KEY#${keyId}`), sk: "META" };
}

/** A request for more spend, waiting for the person who can approve it. */
export function spendRequestKey(orgId: OrgId, requestId: string): OrgKey {
  return { pk: orgScoped(orgId, `SPEND_REQUEST#${requestId}`), sk: "META" };
}

/** Lists the spend requests still open, oldest first (`createdAt` is an instant). */
export function openSpendRequestsKey(orgId: OrgId, createdAt: string, requestId: string): OrgKey {
  return { pk: orgScoped(orgId, "SPEND_REQUESTS#OPEN"), sk: `${canonicalInstant(createdAt)}#${requestId}` };
}

/** A task paused for a budget; `pauseKey` names what it waits for, so raising that budget finds every task to resume. */
export function pausedTasksKey(orgId: OrgId, pauseKey: string, taskId: string): OrgKey {
  return { pk: orgScoped(orgId, `PAUSED_TASKS#${pauseKey}`), sk: taskId };
}

/** What one finished run cost, listed by project, agent and path for the estimates (`endedAt` is an instant). */
export function runCostKey(orgId: OrgId, project: string, agentId: AgentId, path: string, endedAt: string, taskId: string): OrgKey {
  return { pk: orgScoped(orgId, `RUN_COST#${project}#${agentId}#${path}`), sk: `${canonicalInstant(endedAt)}#${taskId}` };
}

/** The total of the monthly budgets of every active agent one person owns (`totalUsd`, changed with ADD in the same transaction as the agent). */
export function ownerBudgetKey(orgId: OrgId, developerId: string): OrgKey {
  return { pk: orgScoped(orgId, `OWNER_AGENT_BUDGET#${developerId}`), sk: "TOTAL" };
}

/**
 * The global index of model keys the broker still settles (ids and `orgId` only; the item names the org and the key, and a reader re-checks
 * `orgId` on the record it points at). `createdAt` is an instant. An item stays until its key was finalized a day ago.
 */
export function openModelKeysKey(createdAt: string, orgId: OrgId, keyId: string): OrgKey {
  return { pk: "OPEN_MODEL_KEYS", sk: `${canonicalInstant(createdAt)}#${orgId}#${keyId}` };
}

/** One settled amount of one key, in the month's ledger (`at` is an instant, `seq` counts the key's settlements). */
export function ledgerKey(orgId: OrgId, month: string, at: string, keyId: string, seq: number): OrgKey {
  return { pk: orgScoped(orgId, `LEDGER#${month}`), sk: `${canonicalInstant(at)}#${keyId}#${String(seq).padStart(6, "0")}` };
}

/** What one run (a task, or the operation of Slack work) cost an agent in a month, for the agent's recent runs. */
export function agentRunsKey(orgId: OrgId, month: string, agentId: AgentId, runId: string): OrgKey {
  return { pk: orgScoped(orgId, `AGENT_RUNS#${month}#${agentId}`), sk: runId };
}
