// Multi-tenancy: the DynamoDB keys whose names two orgs can share (a project called "web", a member
// grant on it, the workspace limits) or that list across tenants (the usage and failure indexes).
// Each one is prefixed with `orgScoped(orgId, ...)`, and nothing else builds these keys.
import { createHash } from "node:crypto";
import { canonicalInstant, indexDay } from "./admin.js";
import { principalKey, type AgentId } from "./agent.js";
export { principalKey } from "./agent.js";
import type { AgentPrincipal, ApprovalId, SkillId } from "./agent-node.js";
import type { SessionId } from "./agent-sessions.js";
import type { DeviceId, SessionBinding } from "./agent-sessions-node.js";
import { OrgIdSchema, type OrgId } from "./org.js";
import { orgScoped, type OrgKey } from "./org-node.js";
import type { ChainId, ChainRunId } from "./chains.js";
import type { EventSource } from "./trigger-specs.js";
import type { TriggerTarget } from "./triggers.js";
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

/**
 * A person's default workspace for a project in one org: the map from (person, project) to the workspace an administrator prepared or the Slack channel started. A person has one
 * owner key across orgs, so the org is part of the key: leaving one org and joining another with a project of the same name never reads the old org's workspace.
 */
export function defaultWorkspaceKey(orgId: OrgId, ownerKey: string, project: string): OrgKey {
  return { pk: orgScoped(orgId, `OWNER#${ownerKey}`), sk: `PROJECT#${project}` };
}

export type OrgSettingName = "WORKSPACE_LIMITS" | "BUDGET" | "BUDGET_SYNCED" | "SPEND_POLICY" | "LOCAL_AGENTS" | "TASK_STOP_POLICY" | "MODEL_SELECTION_POLICY";

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

/** The index item that lists, per principal, the agents shared with it. */
export function principalSharesKey(orgId: OrgId, principal: AgentPrincipal, agentId: AgentId): OrgKey {
  return { pk: orgScoped(orgId, `AGENT_SHARES#${principalKey(principal)}`), sk: agentId };
}

/** The index item that lists, per principal, the chains shared with it (chains have their own partition, so an agent listing never sees them). */
export function principalChainSharesKey(orgId: OrgId, principal: AgentPrincipal, chainId: ChainId): OrgKey {
  return { pk: orgScoped(orgId, `CHAIN_SHARES#${principalKey(principal)}`), sk: chainId };
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

/** The one partition that lists every member merge whose moves have not been finished yet. A named exception to org scoping: ids and the org only. The sign-in function can write it (PutItem, nothing else). */
export const MEMBER_MERGE_QUEUE_PK = "MEMBER_MERGE_QUEUE";

/** The partition that lists every member removal whose moves have not been finished yet. The broker's alone: no other role is granted it by name. */
export const MEMBER_REMOVAL_QUEUE_PK = "MEMBER_REMOVAL_QUEUE";

/**
 * The marker of one member merge the broker has yet to finish, in the sparse `MEMBER_MERGE_QUEUE` partition, so one query lists them all oldest
 * first. Keyed `<instant>#<orgId>#<duplicateId>` and written by the sign-in function in the merge's own transaction. The item holds ids and
 * `orgId` only; whoever reads it checks `orgId` against the key. `at` is an instant.
 */
export function memberMergeQueueKey(at: string, orgId: OrgId, duplicateId: string): OrgKey {
  return { pk: MEMBER_MERGE_QUEUE_PK, sk: `${canonicalInstant(at)}#${orgId}#${duplicateId}` };
}

/** The marker of one member removal, in the broker-only `MEMBER_REMOVAL_QUEUE` partition; keyed like a merge's. Written in the removal's own transaction. */
export function memberRemovalQueueKey(at: string, orgId: OrgId, developerId: string): OrgKey {
  return { pk: MEMBER_REMOVAL_QUEUE_PK, sk: `${canonicalInstant(at)}#${orgId}#${developerId}` };
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

/**
 * Every org's open spend requests, oldest first, for the settlement run's escalation and expiry (the ids and the org only; the reader re-checks `orgId` on the
 * record it points at, as with `openApprovalKey`). `createdAt` is an instant.
 */
export function openSpendRequestDueKey(createdAt: string, orgId: OrgId, requestId: string): OrgKey {
  return { pk: "OPEN_SPEND_REQUESTS", sk: `${canonicalInstant(createdAt)}#${orgId}#${requestId}` };
}

/**
 * The one PENDING request of a kind for a subject (a task, or for `owner_cap` an agent or a person): put in the transaction that makes the request and
 * deleted in the one that ends it, so a second pause on the same subject finds the first request instead of making another.
 */
export function spendRequestSlotKey(orgId: OrgId, subject: string, kind: string): OrgKey {
  return { pk: orgScoped(orgId, `SPEND_REQUEST_FOR#${subject}`), sk: kind };
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

// ---- comment-triggered workflows (Plan 3 Task 14b)

/** The partition of an org's comment-trigger opt-outs: one item per (repository, project), listed with one query. */
export function commentTriggerOptOutsPk(orgId: OrgId): string {
  return orgScoped(orgId, "COMMENT_TRIGGER_OPT_OUTS");
}

/** The sort-key prefix of every project's opt-out for one repository (`owner/name`, lower case), for a query on `commentTriggerOptOutsPk`. */
export function commentTriggerOptOutRepositoryPrefix(repository: string): string {
  return `${repository.toLowerCase()}#`;
}

/** An opt-out of the repository-level comment rule for one repository on one project. The repository is `owner/name` (letters, digits, `_`, `.`, `-`: no `#`). */
export function commentTriggerOptOutKey(orgId: OrgId, repository: string, project: string): OrgKey {
  return { pk: commentTriggerOptOutsPk(orgId), sk: `${commentTriggerOptOutRepositoryPrefix(repository)}${project}` };
}

/** The partition of an org's comment-trigger events (an opt-out applied or lapsed); a lapse is also the notice maintainers and admins are shown. */
export function commentTriggerEventsPk(orgId: OrgId): string {
  return orgScoped(orgId, "COMMENT_TRIGGER_EVENTS");
}

/** One event of `kind` ("applied" or "lapsed", so each kind lists on its own); `at` is an instant and `eventId` makes the key unique. */
export function commentTriggerEventKey(orgId: OrgId, kind: "applied" | "lapsed", at: string, eventId: string): OrgKey {
  return { pk: commentTriggerEventsPk(orgId), sk: `EVENT#${kind}#${canonicalInstant(at)}#${eventId}` };
}

/** What one run looked up and keeps for its own length (a repository scan, a connector's label names): one item per (org, task, kind, name). */
export function runCacheKey(orgId: OrgId, taskId: string, kind: string, name: string): OrgKey {
  return { pk: orgScoped(orgId, `RUN_CACHE#${taskId}`), sk: `${kind}#${name}` };
}

/** The partition holding the items a task's agent created during its run (Task 20b): a later change to one of them is the run's own. */
export function agentItemsPk(orgId: OrgId, taskId: string): string {
  return orgScoped(orgId, `AGENT_ITEMS#${taskId}`);
}

/** One item the run created: `<connector>#<value>`, the value as the connector's item path names it. */
export function agentItemKey(orgId: OrgId, taskId: string, connector: string, value: string): OrgKey {
  return { pk: agentItemsPk(orgId, taskId), sk: `${connector}#${value}` };
}

// ---- chains (Plan 4 Task 1)

const CHAIN_VERSION_WIDTH = 6;
const MAX_CHAIN_VERSION = 10 ** CHAIN_VERSION_WIDTH - 1;
const STEP_SEQ_WIDTH = 4;
const RUN_EVENT_SEQ_WIDTH = 6;

export type ChainItemSk = "META" | "DRAFT" | `VERSION#${string}` | `SHARE#${string}` | `EVENT#${string}`;

/** One chain's partition: its META, its DRAFT, immutable versions, shares and events. */
export function chainKey(orgId: OrgId, chainId: ChainId, sk: ChainItemSk): OrgKey {
  return { pk: orgScoped(orgId, `CHAIN#${chainId}`), sk };
}

/** The sort key of a published chain version; six digits keep a query on `VERSION#` in version order. */
export function chainVersionSk(version: number): `VERSION#${string}` {
  if (!Number.isInteger(version) || version < 1 || version > MAX_CHAIN_VERSION) throw new Error(`a chain version is a whole number from 1 to ${MAX_CHAIN_VERSION}`);
  return `VERSION#${String(version).padStart(CHAIN_VERSION_WIDTH, "0")}`;
}

/** The org's chain directory: one item per chain, for listing without reading every partition. */
export function chainDirectoryKey(orgId: OrgId, chainId: ChainId): OrgKey {
  return { pk: orgScoped(orgId, "CHAINS"), sk: chainId };
}

/** The item that makes a chain's name unique in its org, ignoring case and surrounding spaces. */
export function chainNameKey(orgId: OrgId, name: string): OrgKey {
  return { pk: orgScoped(orgId, `CHAIN_NAME#${name.trim().toLowerCase()}`), sk: "META" };
}

export type ChainRunItemSk = "META" | `STEP#${string}` | `EVENT#${string}`;

/** One chain run's partition: its META, one item per step attempt and its event log. */
export function chainRunKey(orgId: OrgId, runId: ChainRunId, sk: ChainRunItemSk): OrgKey {
  return { pk: orgScoped(orgId, `CHAIN_RUN#${runId}`), sk };
}

function paddedSeq(seq: number, width: number, what: string): string {
  const max = 10 ** width - 1;
  if (!Number.isInteger(seq) || seq < 0 || seq > max) throw new Error(`${what} is a whole number from 0 to ${max}`);
  return String(seq).padStart(width, "0");
}

/** The sort key of a step attempt in a run; four digits keep a query on `STEP#` in order. */
export function stepSk(seq: number): `STEP#${string}` {
  return `STEP#${paddedSeq(seq, STEP_SEQ_WIDTH, "a step sequence number")}`;
}

/** The sort key of a run event; six digits keep a query on `EVENT#` in order. */
export function runEventSk(seq: number): `EVENT#${string}` {
  return `EVENT#${paddedSeq(seq, RUN_EVENT_SEQ_WIDTH, "an event sequence number")}`;
}

/** The index item that lists a chain's runs, newest last; `createdAt` is an instant. */
export function chainRunsByChainKey(orgId: OrgId, chainId: ChainId, createdAt: string, runId: ChainRunId): OrgKey {
  return { pk: chainRunsByChainPk(orgId, chainId), sk: `${canonicalInstant(createdAt)}#${runId}` };
}

/** The partition of a chain's run index: a list of the chain's runs queries it. */
export function chainRunsByChainPk(orgId: OrgId, chainId: ChainId): string {
  return orgScoped(orgId, `CHAIN_RUNS#${chainId}`);
}

/** The index item that lists a project's chain runs, newest last; `createdAt` is an instant. */
export function chainRunsByProjectKey(orgId: OrgId, project: string, createdAt: string, runId: ChainRunId): OrgKey {
  return { pk: chainRunsByProjectPk(orgId, project), sk: `${canonicalInstant(createdAt)}#${runId}` };
}

/** The partition of a project's chain-run index: a list of the project's runs queries it. */
export function chainRunsByProjectPk(orgId: OrgId, project: string): string {
  return orgScoped(orgId, `CHAIN_RUNS_P#${project}`);
}

/**
 * The global index of chain runs still open, in the order they are next due (ids only: the item names the org and the run, and a reader
 * re-checks `orgId` on the record it points at). `dueAt` is an instant.
 */
export function openChainRunKey(dueAt: string, orgId: OrgId, runId: ChainRunId): OrgKey {
  return { pk: "OPEN_CHAIN_RUNS", sk: `${canonicalInstant(dueAt)}#${orgId}#${runId}` };
}

// ---- triggers (Plan 4 Task 18)

/** The name a trigger's target goes by in keys: `CHAIN#<id>` or `AGENT#<id>`. */
export function triggerTargetKey(target: TriggerTarget): string {
  return target.kind === "chain" ? `CHAIN#${target.chainId}` : `AGENT#${target.agentId}`;
}

/** A trigger's record. */
export function triggerKey(orgId: OrgId, triggerId: string): OrgKey {
  return { pk: orgScoped(orgId, `TRIGGER#${triggerId}`), sk: "META" };
}

/** The index item that lists a target's triggers (`targetKey` is `triggerTargetKey(target)`), and its counter at `COUNT`. */
export function targetTriggersKey(orgId: OrgId, targetKey: string, triggerId: string): OrgKey {
  return { pk: orgScoped(orgId, `TARGET_TRIGGERS#${targetKey}`), sk: triggerId };
}

/** The counter of a target's triggers, beside the index items: a transaction that adds a trigger is held to `MAX_TRIGGERS_PER_TARGET` by it. */
export function targetTriggerCountKey(orgId: OrgId, targetKey: string): OrgKey {
  return { pk: orgScoped(orgId, `TARGET_TRIGGERS#${targetKey}`), sk: "COUNT" };
}

/** The index item that lists the triggers a member created, so a removed or merged member's can be found. */
export function triggersByCreatorKey(orgId: OrgId, developerId: string, triggerId: string): OrgKey {
  return { pk: orgScoped(orgId, `TRIGGERS_BY_CREATOR#${developerId}`), sk: triggerId };
}

/** The index item dispatch reads: the triggers of the receiving hook only (`hookId` is `"github"` for GitHub's, which have none). */
export function triggerMatchKey(orgId: OrgId, source: EventSource, project: string, hookId: string, triggerId: string): OrgKey {
  return { pk: orgScoped(orgId, `TRIGGERS#${source}#${project}#${hookId}`), sk: triggerId };
}

/**
 * The global list of schedule triggers whose schedule the scheduler does not hold as the trigger says (`scheduleStatus: "pending"`), for the sweep that repairs them. Like the
 * open-run list it names the org and the trigger and nothing else: a reader reads the record under that org's own key.
 */
export function pendingTriggerScheduleKey(orgId: OrgId, triggerId: string): OrgKey {
  return { pk: "PENDING_TRIGGER_SCHEDULES", sk: `${orgId}#${triggerId}` };
}

/** One thing a trigger did or was told, newest last; it expires with `TRIGGER_ACTIVITY_TTL_DAYS`. */
export function triggerActivityKey(orgId: OrgId, triggerId: string, at: string, eventKey: string): OrgKey {
  return { pk: orgScoped(orgId, `TRIGGER_ACTIVITY#${triggerId}`), sk: `${canonicalInstant(at)}#${eventKey}` };
}

/** A notice stored for a member to be shown (Plan 7) and posted (Plan 9), as Plan 3 stores budget alerts. */
export function triggerNoticeKey(orgId: OrgId, developerId: string, at: string, triggerId: string): OrgKey {
  return { pk: orgScoped(orgId, `TRIGGER_NOTICES#${developerId}`), sk: `${canonicalInstant(at)}#${triggerId}` };
}

// ---- the limits dispatch counts against (Plan 4 Task 20)

/** The count of runs one trigger started in one UTC hour (`hour` is `YYYY-MM-DDTHH`); it expires after two hours. */
export function triggerRateKey(orgId: OrgId, triggerId: string, hour: string): OrgKey {
  return { pk: orgScoped(orgId, `TRIGGER_RATE#${triggerId}`), sk: hour };
}

/** The count of runs events and schedules started for the whole org in one UTC day (`day` is `YYYY-MM-DD`); it expires after two days. */
export function orgAutonomousKey(orgId: OrgId, day: string): OrgKey {
  return { pk: orgScoped(orgId, "ORG_AUTONOMOUS"), sk: day };
}

/**
 * The note that one trigger started a run for one subject (a pull request, an issue, an incident...) and when: the sort key is the SHA-256 of what names the subject. Dispatch
 * reads it so that an event on the subject the trigger's own run may have caused is not started again within `TRIGGER_SUBJECT_GUARD_MINUTES`; it expires after two hours.
 */
export function triggerSubjectKey(orgId: OrgId, triggerId: string, subject: { kind: string; id: string; url?: string | undefined }): OrgKey {
  return { pk: orgScoped(orgId, `TRIGGER_SUBJECT#${triggerId}`), sk: createHash("sha256").update(`${subject.kind}\0${subject.id}\0${subject.url ?? ""}`, "utf8").digest("hex") };
}

// ---- agent sessions (Plan 5 Task 1)

/** A key segment: never empty and never holds the `#` that separates segments, so one segment can't be read as two. */
function keyPart(value: string, what: string): string {
  if (value.length === 0 || value.includes("#") || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error(`${what} can't be empty or hold a "#" or a control character`);
  return value;
}

const SESSION_COUNTER_WIDTH = 6;

function paddedCounter(value: number, what: string): string {
  if (!Number.isInteger(value) || value < 0 || value >= 10 ** SESSION_COUNTER_WIDTH) throw new Error(`${what} is a whole number from 0 to ${String(10 ** SESSION_COUNTER_WIDTH - 1)}`);
  return String(value).padStart(SESSION_COUNTER_WIDTH, "0");
}

/** The sort keys inside one session's partition. Events sort by time, then id (`sessionEventSk`); legs by number (`sessionLegSk`). */
export type AgentSessionItemSk =
  | "META"
  | `SHARE#${string}`
  | `FOLLOWER#${string}`
  | `PRESENCE#${string}`
  | `MESSAGE#${string}`
  | `TURN#${string}`
  | "LOCAL"
  | `EVENT#${string}`
  | `LEG#${string}`
  | `TAKE_OVER_FOLLOW_UP#${string}`
  | `REQUEST#${string}`
  | `HANDOFF_PENDING#${string}`
  | "RETRIED";

/** One session's partition: its META header, shares, followers, who is looking now, messages, local turns, events, legs and the marks a take-over owes (`TAKE_OVER_FOLLOW_UP#<approvalId>`), the requests a stop or retry answered (`REQUEST#<requestId>`) and the one retry a session had (`RETRIED`). */
export function agentSessionKey(orgId: OrgId, sessionId: SessionId, sk: AgentSessionItemSk): OrgKey {
  return { pk: orgScoped(orgId, `AGENT_SESSION#${keyPart(sessionId, "a session id")}`), sk };
}

/** A local session's transcript line, `TURN#<number>`; six digits keep a query on `TURN#` in order. */
export function sessionTurnSk(seq: number): `TURN#${string}` {
  return `TURN#${paddedCounter(seq, "a turn number")}`;
}

/** An event's sort key: `EVENT#<instant>#<eventId>`, so a query on `EVENT#` reads them in order. */
export function sessionEventSk(at: string, eventId: string): `EVENT#${string}` {
  return `EVENT#${canonicalInstant(at)}#${keyPart(eventId, "an event id")}`;
}

/** A leg's sort key; six digits keep a query on `LEG#` in leg order. */
export function sessionLegSk(seq: number): `LEG#${string}` {
  return `LEG#${paddedCounter(seq, "a leg number")}`;
}

/** The org's live index: one item per open session (and recently ended ones), keyed by session id. */
export function liveSessionKey(orgId: OrgId, sessionId: SessionId): OrgKey {
  return { pk: orgScoped(orgId, "LIVE_SESSIONS"), sk: keyPart(sessionId, "a session id") };
}

/**
 * Who is looking at which session, for the whole org, so the Live wall reads every tile's viewers in one query instead of one per session: one item per (session, person), written
 * by the same heartbeat as the session's own presence item and expiring with it. Display only; the session's own `PRESENCE#` items stay what a session's view reads.
 */
export function livePresenceKey(orgId: OrgId, sessionId: SessionId, developerId: string): OrgKey {
  return { pk: orgScoped(orgId, "LIVE_PRESENCE"), sk: `${keyPart(sessionId, "a session id")}#${keyPart(developerId, "a developer id")}` };
}

/** The sessions one person owns, newest last; `createdAt` is an instant. */
export function mySessionsKey(orgId: OrgId, developerId: string, createdAt: string, sessionId: SessionId): OrgKey {
  return { pk: orgScoped(orgId, `MY_SESSIONS#${keyPart(developerId, "a developer id")}`), sk: `${canonicalInstant(createdAt)}#${keyPart(sessionId, "a session id")}` };
}

/**
 * The cards one person dismissed from Home (Plan 5 Task 15), one item per card, in a partition of their own: a person's dismissals are read in one query and are never another person's.
 * `cardId` is `<kind>:<id>`.
 */
export function homeDismissedKey(orgId: OrgId, developerId: string, cardId: string): OrgKey {
  return { pk: orgScoped(orgId, `HOME_DISMISSED#${keyPart(developerId, "a developer id")}`), sk: keyPart(cardId, "a card id") };
}

/** The sessions on one project, newest last; `createdAt` is an instant. */
export function projectSessionsKey(orgId: OrgId, project: string, createdAt: string, sessionId: SessionId): OrgKey {
  return { pk: orgScoped(orgId, `PROJECT_SESSIONS#${keyPart(project, "a project name")}`), sk: `${canonicalInstant(createdAt)}#${keyPart(sessionId, "a session id")}` };
}

/** The sessions shared with one principal (a member, a project or the org), for "Shared with me". */
export function sharedSessionsKey(orgId: OrgId, principal: AgentPrincipal, sessionId: SessionId): OrgKey {
  return { pk: orgScoped(orgId, `SHARED_SESSIONS#${principalKey(principal)}`), sk: keyPart(sessionId, "a session id") };
}

/** The item that remembers what one request on a session did (R18): one per (org, developer, request id), written in the change's own transaction. */
export function sessionRequestKey(orgId: OrgId, developerId: string, requestId: string): OrgKey {
  return { pk: orgScoped(orgId, `SESSION_REQUEST#${keyPart(developerId, "a developer id")}`), sk: keyPart(requestId, "a request id") };
}

/**
 * The item that counts one person's comments (`kind` "comment") or changes to them ("change") on one session in the current ten-minute window, or their messages to the agent
 * ("steer") in the current hour: `<kind>#<developerId>` in the session's rate partition. `steer_all` counts every person's messages to the agent on the session (its `developerId` is the word `session`).
 */
export function sessionRateKey(orgId: OrgId, sessionId: SessionId, developerId: string, kind: "comment" | "change" | "steer" | "steer_all" | "local_update" | "local_status" | "local_stop"): OrgKey {
  return { pk: orgScoped(orgId, `SESSION_RATE#${keyPart(sessionId, "a session id")}`), sk: `${kind}#${keyPart(developerId, "a developer id")}` };
}

/**
 * The count of a session's messages to the agent that are still queued (not yet taken by a step or answered), in the session's own partition. It goes up in the transaction that writes
 * a queued message and down in the one that answers it, so "nothing is queued" is one read, and it sits among the messages so retention reaches it (its sort key is not a message's).
 */
export function sessionQueuedSteersKey(orgId: OrgId, sessionId: SessionId): OrgKey {
  return agentSessionKey(orgId, sessionId, "MESSAGE#QUEUED");
}

/** What one task has cost so far, added to when a model key settles, so a session shows cost without summing keys. */
export function taskSpendKey(orgId: OrgId, taskId: string): OrgKey {
  return { pk: orgScoped(orgId, `TASK_SPENT#${keyPart(taskId, "a task id")}`), sk: "META" };
}

/** The global list of open sessions, swept every few minutes. A named exception to org scoping: ids and the org only; a reader re-checks `orgId` on the record. */
export function openAgentSessionKey(orgId: OrgId, sessionId: SessionId): OrgKey {
  return { pk: "OPEN_AGENT_SESSIONS", sk: `${orgId}#${keyPart(sessionId, "a session id")}` };
}

/** The global list of sessions that ended on one UTC day (`day` is `YYYY-MM-DD`), for the retention job. Ids and the org only. */
export function endedSessionWorkKey(day: string, orgId: OrgId, sessionId: SessionId): OrgKey {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00.000Z`))) throw new Error("a day is YYYY-MM-DD");
  return { pk: `ENDED_AGENT_SESSIONS#${day}`, sk: `${orgId}#${keyPart(sessionId, "a session id")}` };
}

/** Where the sweep remembers how far it got. A global item holding no org. */
export const SESSION_SWEEP_CURSOR_KEY: OrgKey = { pk: "SESSION_SWEEP_CURSOR", sk: "META" };

/**
 * A session's own record of an outside place it follows (`BINDING#<kind>`: `slack_thread` or `linear_issue`), in a partition of its own, not the session's. The Slack notifier writes it, and
 * an IAM grant can limit a writer by partition key only, so keeping it out of the session partition keeps that role away from the session's META, shares and everything else in it.
 */
export function sessionBindingKey(orgId: OrgId, sessionId: SessionId, kind: SessionBinding["kind"]): OrgKey {
  return { pk: orgScoped(orgId, `SESSION_BINDING#${keyPart(sessionId, "a session id")}`), sk: `BINDING#${kind}` };
}

/** The item that binds one outside surface (a Slack thread or a Linear issue) to one session: one binding per surface per org. */
export function sessionSurfaceKey(orgId: OrgId, binding: SessionBinding): OrgKey {
  const sk = binding.kind === "slack_thread"
    ? `SLACK#${keyPart(binding.teamId, "a Slack team")}#${keyPart(binding.channelId, "a Slack channel")}#${keyPart(binding.threadTs, "a thread")}`
    : `LINEAR#${keyPart(binding.issueId, "an issue id")}`;
  return { pk: orgScoped(orgId, "SESSION_SURFACE"), sk };
}

/** One person's change notice (ids only), kept for the catch-up feed; `at` is an instant and `n` orders notices written in one instant. */
export function changesKey(orgId: OrgId, developerId: string, at: string, n: number): OrgKey {
  return { pk: orgScoped(orgId, `CHANGES#${keyPart(developerId, "a developer id")}`), sk: `${canonicalInstant(at)}#${paddedCounter(n, "a notice number")}` };
}

/** A project's session counts for one UTC month (`month` is `YYYY-MM`). */
export function projectMonthStatsKey(orgId: OrgId, project: string, month: string): OrgKey {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(month)) throw new Error("a month is YYYY-MM");
  return { pk: orgScoped(orgId, `PROJECT_SESSION_STATS#${keyPart(project, "a project name")}`), sk: month };
}

/** A registered Mac: its record and its command queue share this partition. */
function devicePk(orgId: OrgId, deviceId: DeviceId): string {
  return orgScoped(orgId, `DEVICE#${keyPart(deviceId, "a device id")}`);
}

export function deviceKey(orgId: OrgId, deviceId: DeviceId): OrgKey {
  return { pk: devicePk(orgId, deviceId), sk: "META" };
}

/** The list of one member's devices, for the per-member limit and the settings page. */
export function memberDevicesKey(orgId: OrgId, developerId: string, deviceId: DeviceId): OrgKey {
  return { pk: orgScoped(orgId, `MEMBER_DEVICES#${keyPart(developerId, "a developer id")}`), sk: keyPart(deviceId, "a device id") };
}

/** The count of commands a device was given: the next command is this plus one. Sits beside the commands (its sort key is not a command's) and expires with them. */
export function deviceCommandCounterKey(orgId: OrgId, deviceId: DeviceId): OrgKey {
  return { pk: devicePk(orgId, deviceId), sk: "COMMAND_SEQ" };
}

/** Which sessions run on a device, one item per session (`SESSION#<sessionId>`), so removing the device finds them without reading its owner's whole list. */
export function deviceSessionKey(orgId: OrgId, deviceId: DeviceId, sessionId: SessionId): OrgKey {
  return { pk: devicePk(orgId, deviceId), sk: `SESSION#${keyPart(sessionId, "a session id")}` };
}

/** A window's count of one kind of write by a Mac (`update`), in the device's own partition so it goes with the device. */
export function deviceRateKey(orgId: OrgId, deviceId: DeviceId, kind: "update"): OrgKey {
  return { pk: devicePk(orgId, deviceId), sk: `RATE#${kind}` };
}

/** A window's count of one kind of write by one person (`local_register`: local sessions started), in a partition of their own. */
export function personRateKey(orgId: OrgId, developerId: string, kind: "local_register"): OrgKey {
  return { pk: orgScoped(orgId, `PERSON_RATE#${keyPart(developerId, "a developer id")}`), sk: kind };
}

/** One command waiting for a device (stop, move to the cloud, a steering message); six digits keep them in order. */
export function deviceCommandKey(orgId: OrgId, deviceId: DeviceId, seq: number): OrgKey {
  return { pk: devicePk(orgId, deviceId), sk: `COMMAND#${paddedCounter(seq, "a command number")}` };
}

// ---- Rovara Code (Plan 6 Task 1)

/** A project's code settings (self-approval, merge method, reviewers). */
export function codeSettingsKey(orgId: OrgId, project: string): OrgKey {
  return { pk: orgScoped(orgId, `CODE_SETTINGS#${keyPart(project, "a project name")}`), sk: "META" };
}

/** A project's playbook ("How we work"): the process the project runs by default. */
export function projectPlaybookKey(orgId: OrgId, project: string): OrgKey {
  return { pk: orgScoped(orgId, `PROJECT_PLAYBOOK#${keyPart(project, "a project name")}`), sk: "META" };
}

/** How long recent tasks of one project took, per path (`QUICK` or `FULL`), for the plan's time estimate. */
export function durationHistoryKey(orgId: OrgId, project: string, path: "QUICK" | "FULL"): OrgKey {
  return { pk: orgScoped(orgId, `DURATION_HISTORY#${keyPart(project, "a project name")}`), sk: path };
}

/** Which member of the org a GitHub account (by its numeric id) is linked to, for telling an approval from a requester's. */
export function githubMemberKey(orgId: OrgId, githubUserId: string): OrgKey {
  return { pk: orgScoped(orgId, `GITHUB_MEMBER#${keyPart(githubUserId, "a GitHub user id")}`), sk: "META" };
}

/** The GitHub account a member of the org linked, the other way round from `githubMemberKey`. */
export function memberGithubKey(orgId: OrgId, developerId: string): OrgKey {
  return { pk: orgScoped(orgId, `MEMBER_GITHUB#${keyPart(developerId, "a developer id")}`), sk: "META" };
}

/** The setup draft Rovara wrote for a project, waiting for a maintainer. */
export function setupDraftKey(orgId: OrgId, project: string): OrgKey {
  return { pk: orgScoped(orgId, `SETUP_DRAFT#${keyPart(project, "a project name")}`), sk: "META" };
}

/** One person's discarded work, kept 7 days. */
export function trashKey(orgId: OrgId, developerId: string, taskId: string): OrgKey {
  return { pk: orgScoped(orgId, `TRASH#${keyPart(developerId, "a developer id")}`), sk: keyPart(taskId, "a task id") };
}

/** Which task a pull request head belongs to, so a check or status event that carries only a commit finds its task. */
export function prHeadKey(orgId: OrgId, repositoryId: string, headSha: string): OrgKey {
  return { pk: orgScoped(orgId, `PR_HEAD#${keyPart(repositoryId, "a repository id")}`), sk: keyPart(headSha, "a commit") };
}

/**
 * Items in the task's own partition (`DEVTASK#<taskId>`, a named exception to org scoping like the task itself): the items carry `orgId` and a reader
 * re-checks it. One tracking item per pull request of the task.
 */
export function mergeTrackingKey(taskId: string, repositoryId: string, number: number): { pk: string; sk: string } {
  if (!Number.isInteger(number) || number <= 0) throw new Error("a pull request number is a positive whole number");
  return { pk: `DEVTASK#${keyPart(taskId, "a task id")}`, sk: `MERGE_TRACKING#${keyPart(repositoryId, "a repository id")}#${String(number)}` };
}

/**
 * A reminder one reviewer was sent about one pull request (Plan 6 Task 18), in the reviewer's own partition of the org: Home reads it to show the reviewer the pull request
 * that waits for them. One item per reviewer and pull request.
 */
export function reviewWaitKey(orgId: OrgId, developerId: string, taskId: string, repositoryId: string, number: number): OrgKey {
  if (!Number.isInteger(number) || number <= 0) throw new Error("a pull request number is a positive whole number");
  return { pk: orgScoped(orgId, `REVIEW_WAIT#${keyPart(developerId, "a developer id")}`), sk: `${keyPart(taskId, "a task id")}#${keyPart(repositoryId, "a repository id")}#${String(number)}` };
}

/** Who one pull request's reminders went to, in the task's own partition (it carries `orgId`, and a reader re-checks it): so a reminder can be taken away when it no longer applies. */
export function reviewNudgeLedgerKey(taskId: string, repositoryId: string, number: number): { pk: string; sk: string } {
  if (!Number.isInteger(number) || number <= 0) throw new Error("a pull request number is a positive whole number");
  return { pk: `DEVTASK#${keyPart(taskId, "a task id")}`, sk: `REVIEW_NUDGE#${keyPart(repositoryId, "a repository id")}#${String(number)}` };
}

/** One milestone of a task: the `n`th of its kind (`n` from 0; six digits keep them in order). */
export function codeMilestoneKey(taskId: string, kind: string, n: number): { pk: string; sk: string } {
  return { pk: `DEVTASK#${keyPart(taskId, "a task id")}`, sk: `CODE_MILESTONE#${keyPart(kind, "a milestone kind")}#${paddedCounter(n, "a milestone number")}` };
}

// ---- Team record (learning v2). One DynamoDB table, `TeamRecord`, one partition per workspace (the org) and project. A workspace's rows never
// share a partition with another's, and every global index key starts with the workspace. Source ids are hashed into index keys because a source's
// own id may hold a "#". The table's TTL attribute is `indexExpiresAt` (INDEX_EXPIRY_ATTRIBUTE).

/** The project segment of a partition for a row that belongs to no project. A project name starts with a letter, so this never collides. */
export const TEAM_RECORD_NO_PROJECT = "_workspace";

/** The two indexes of the TeamRecord table: GSI1 finds rows by their source (delete at the source), GSI2 by the person (erase). */
export const TEAM_RECORD_GSI1 = { index: "gsi1", partition: "gsi1pk" } as const;
export const TEAM_RECORD_GSI2 = { index: "gsi2", partition: "gsi2pk" } as const;
/** GSI5 is sparse: only rows that still hold raw text with an expiry carry it (`gsi5pk` one value per workspace, `textDueAt` the expiry as an ISO time), so the text-expiry job finds exactly the due rows. */
export const TEAM_RECORD_GSI5 = { index: "gsi5", partition: "gsi5pk", sort: "textDueAt" } as const;
export function recordTextDueIndexValue(orgId: OrgId): string {
  return `WS#${OrgIdSchema.parse(orgId)}#TEXTDUE`;
}
/** GSI4 finds rows by the source identity of their actor (a person with no developer id). */
export const TEAM_RECORD_GSI4 = { index: "gsi4", partition: "gsi4pk" } as const;
/** GSI3 finds rows by their scope (a Slack channel, a repository): a deleted channel, a membership change, a channel that turned private. */
export const TEAM_RECORD_GSI3 = { index: "gsi3", partition: "gsi3pk", sort: "gsi3sk" } as const;
/**
 * What GSI3 projects besides its keys (the table's own keys `pk` and `sk` come with it). The place scan is used by the tombstone fan-out and the audience changes only, so it
 * carries what they read and never an item's text. Search does not use this index. A new use of `byScope` that reads another attribute must add it here BEFORE the first deploy.
 */
export const TEAM_RECORD_GSI3_ATTRIBUTES = ["entityType", "tombstone", "id", "sourceRef", "audience", "factId", "createdAt", "scope", "system", "project"] as const;

const TEAM_RECORD_COUNTER_WIDTH = 12;
const teamRecordCounter = (value: number, what: string): string => {
  if (!Number.isInteger(value) || value < 0 || value >= 10 ** TEAM_RECORD_COUNTER_WIDTH) throw new Error(`${what} is a whole number below 10^${String(TEAM_RECORD_COUNTER_WIDTH)}`);
  return String(value).padStart(TEAM_RECORD_COUNTER_WIDTH, "0");
};

/** The partition holding one project's record rows, facts, lessons, skills, load manifests and source settings in one workspace. */
export function teamRecordPk(orgId: OrgId, project?: string): string {
  return `WS#${OrgIdSchema.parse(orgId)}#P#${project === undefined ? TEAM_RECORD_NO_PROJECT : keyPart(project, "a project name")}`;
}

/** The first characters of the partition of any one workspace, for a walk of everything it holds (org close). */
export function teamRecordWorkspacePrefix(orgId: OrgId): string {
  return `WS#${OrgIdSchema.parse(orgId)}#`;
}

/** The workspace a record partition belongs to, or undefined for a key that is not one. */
export function orgOfTeamRecordPk(pk: string): OrgId | undefined {
  const parsed = OrgIdSchema.safeParse(/^WS#(org_[0-9a-z]{20})#P#/.exec(pk)?.[1]);
  return parsed.success ? parsed.data : undefined;
}

/**
 * A hash of a source's own id (so a "#" in it cannot move a key boundary): sha256 over the system, a NUL and the id, as 64 hex. The lake's `source_hash`
 * column is the same value, so a delete at a source reaches the hot row, the vector and the lake row by one key.
 */
export function teamRecordSourceHash(system: string, sourceId: string): string {
  if (system.length === 0 || system.includes("\u0000")) throw new Error("a source system can't be empty or hold a NUL");
  return createHash("sha256").update(`${system}\u0000${sourceId}`).digest("hex");
}

/** `REC#<time>#<id>`: a record event, in time order. `id` is the event's uuid. */
export function recordEventKey(orgId: OrgId, project: string | undefined, occurredAt: string, eventId: string): OrgKey {
  return { pk: teamRecordPk(orgId, project), sk: `REC#${canonicalInstant(occurredAt)}#${keyPart(eventId, "an event id")}` };
}
export const RECORD_EVENT_SK_PREFIX = "REC#";

/** The GSI1 partition value of every row that came from one source item: its record events and the derivation links of the facts built from it. */
export function recordSourceIndexValue(orgId: OrgId, system: string, sourceId: string): string {
  return `WS#${OrgIdSchema.parse(orgId)}#SRC#${keyPart(system, "a source system")}#${teamRecordSourceHash(system, sourceId)}`;
}
/**
 * The head of one source item (in the workspace partition): the version time of the newest version stored, its version, the LOWEST trust any version ever had, and where the
 * newest row is. It orders versions by source time (an older version arriving late is a no-op), says which row a newer version replaces, and answers the ingest lane's
 * "lowest trust this item ever had". Keyed by the source system and item id; the same hash as the lake's `source_hash`.
 */
export function recordItemHeadKey(orgId: OrgId, system: string, sourceId: string): OrgKey {
  return { pk: teamRecordPk(orgId), sk: `ITEM#${teamRecordSourceHash(system, sourceId)}` };
}
/**
 * A place that was deleted or excluded (a channel, a repository, a whole workspace of one source: `slack:T1`). It covers every place under it (`slack:T1/C9`), is
 * permanent, and stops any later put under it. Saving a source row for the place again clears it.
 */
export function recordScopeMarkerKey(orgId: OrgId, scope: string): OrgKey {
  return { pk: teamRecordPk(orgId), sk: `SCOPEDEL#${createHash("sha256").update(scope).digest("hex")}` };
}
/**
 * The ONE access record of a place (a channel, a repository): who may read what was recorded there, kept apart from the rows. Reads check it for every hit, so a row whose
 * own snapshot is stale (a list captured before someone left) never grants more than this record does. Keyed by the place's hash (in the workspace partition).
 */
export function recordAccessKey(orgId: OrgId, scope: string): OrgKey {
  return { pk: teamRecordPk(orgId), sk: `ACCESS#${createHash("sha256").update(scope).digest("hex")}` };
}
/** The places a scope sits under, itself first: `slack:T1/C9` -> `slack:T1/C9`, `slack:T1`. */
export function scopeAndAncestors(scope: string): string[] {
  const out = [scope];
  let current = scope;
  for (;;) {
    const at = current.lastIndexOf("/");
    if (at <= 0) return out;
    current = current.slice(0, at);
    out.push(current);
  }
}
/** A marker that one source item was deleted at its source (kept for a while, in the workspace partition), so a late retry of its create cannot bring it back. */
export function recordDeletedMarkerKey(orgId: OrgId, system: string, sourceId: string): OrgKey {
  return { pk: teamRecordPk(orgId), sk: `DELETED#${teamRecordSourceHash(system, sourceId)}` };
}
/** The GSI1 partition value of the one source row (`SOURCE#`) of a scope: how a tap finds a scope's retention and audience without knowing its project. */
export function recordSourceConfigIndexValue(orgId: OrgId, source: string, scope: string): string {
  return `WS#${OrgIdSchema.parse(orgId)}#CFG#${teamRecordSourceHash(source, scope)}`;
}
/**
 * The hashes the lake keeps beside a row so it can be erased without free text in SQL (the lake's `actor_source_hash` and `scope_hash` columns). A person with no
 * developer id (an outsider, an unmapped Slack user) is erased by `recordActorSourceHash`; a place (a deleted channel or repository) by `recordScopeHash`.
 */
export function recordActorSourceHash(system: string, actorSourceId: string): string {
  return createHash("sha256").update(`actor\u0000${system}\u0000${actorSourceId}`).digest("hex");
}
export function recordScopeHash(scope: string): string {
  return createHash("sha256").update(`scope\u0000${scope}`).digest("hex");
}
/** The GSI4 partition value of every row made by one source identity (erase a person who has no developer id). */
export function recordActorSourceIndexValue(orgId: OrgId, system: string, actorSourceId: string): string {
  return `WS#${OrgIdSchema.parse(orgId)}#ACTORSRC#${recordActorSourceHash(keyPart(system, "a source system"), actorSourceId)}`;
}
/**
 * An erased person, kept for good (no expiry) so a backfill, a poller or an edit cannot bring them back. By developer id, or by the hash of a source identity
 * (`recordActorSourceHash`) for someone who never had a developer id.
 */
export function erasedPersonKey(orgId: OrgId, who: { developerId: string } | { actorSourceHash: string }): OrgKey {
  return { pk: teamRecordPk(orgId), sk: "developerId" in who ? `ERASED#dev#${keyPart(who.developerId, "a developer id")}` : `ERASED#src#${keyPart(who.actorSourceHash, "a hash")}` };
}
/** Which vector bucket holds a workspace's index, written once when the workspace gets its index and read back from then on (a second bucket must never remap a workspace). */
export function workspaceVectorBucketKey(orgId: OrgId): OrgKey {
  return { pk: teamRecordPk(orgId), sk: "VECBUCKET" };
}
/** The top of a place: `slack:T1/C9` -> `slack:T1`; a place with no `/` is its own top. */
export function scopeRoot(scope: string): string {
  const at = scope.indexOf("/");
  return at <= 0 ? scope : scope.slice(0, at);
}
/**
 * The GSI3 partition value of every row under one top place (`slack:T1`, `github:repo`; a scope is already prefixed with its source). The sort value is the row's own
 * place, so one query finds a place AND every place under it (a tombstone of `slack:T1` reaches `slack:T1/C9`).
 */
export function recordScopeIndexValue(orgId: OrgId, scope: string): string {
  if (scope.length === 0) throw new Error("a scope can't be empty");
  return `WS#${OrgIdSchema.parse(orgId)}#SCOPE#${createHash("sha256").update(scopeRoot(scope)).digest("hex")}`;
}
/**
 * The GSI3 partition value of the PLACE rows (the source rows) under one top place. Finding the places below a place reads only these, so it is bounded by the number of
 * places and never by the number of stored items.
 */
export function recordPlaceIndexValue(orgId: OrgId, scope: string): string {
  return `${recordScopeIndexValue(orgId, scope)}#PLACES`;
}
/** The GSI2 partition value of every row a person's actions made (person erase). */
export function recordActorIndexValue(orgId: OrgId, developerId: string): string {
  return `WS#${OrgIdSchema.parse(orgId)}#ACTOR#${keyPart(developerId, "a developer id")}`;
}

export function recordFactKey(orgId: OrgId, project: string | undefined, factId: string): OrgKey {
  return { pk: teamRecordPk(orgId, project), sk: `FACT#${keyPart(factId, "a fact id")}` };
}
export const RECORD_FACT_SK_PREFIX = "FACT#";

/** A link from a source item to a fact distilled from it, so a delete at a source that stored no row (retention B) still finds its facts. */
export function recordDerivationKey(orgId: OrgId, project: string | undefined, system: string, sourceId: string, factId: string): OrgKey {
  return { pk: teamRecordPk(orgId, project), sk: `DERIV#${teamRecordSourceHash(system, sourceId)}#${keyPart(factId, "a fact id")}` };
}
export const RECORD_DERIVATION_SK_PREFIX = "DERIV#";

export function lessonKey(orgId: OrgId, project: string, lessonId: string): OrgKey {
  return { pk: teamRecordPk(orgId, project), sk: `LESSON#${keyPart(lessonId, "a lesson id")}` };
}
export const LESSON_SK_PREFIX = "LESSON#";
export function lessonVersionKey(orgId: OrgId, project: string, lessonId: string, version: number): OrgKey {
  return { pk: teamRecordPk(orgId, project), sk: `LESSON#${keyPart(lessonId, "a lesson id")}#V#${teamRecordCounter(version, "a lesson version")}` };
}
/** The project's lesson-set version counter (monotonic; a load manifest records it so a task's context can be reproduced). */
export function lessonSetKey(orgId: OrgId, project: string): OrgKey {
  return { pk: teamRecordPk(orgId, project), sk: "LESSONSET" };
}
export function learnedSkillKey(orgId: OrgId, project: string, skillId: string): OrgKey {
  return { pk: teamRecordPk(orgId, project), sk: `SKILL#${keyPart(skillId, "a skill id")}` };
}
export function learnedSkillVersionKey(orgId: OrgId, project: string, skillId: string, version: number): OrgKey {
  return { pk: teamRecordPk(orgId, project), sk: `SKILL#${keyPart(skillId, "a skill id")}#V#${teamRecordCounter(version, "a skill version")}` };
}
/** What the agent loaded for one stage dispatch. An eval run writes `EVALLOAD#` instead, so the live counters never see it. */
export function loadManifestKey(orgId: OrgId, project: string, taskId: string, stage: string, round: number, evalRun = false): OrgKey {
  return { pk: teamRecordPk(orgId, project), sk: `${evalRun ? "EVALLOAD" : "LOAD"}#${keyPart(taskId, "a task id")}#${keyPart(stage, "a stage")}#${paddedCounter(round, "a round")}` };
}
export function recordSourceKey(orgId: OrgId, project: string, system: string, scope: string): OrgKey {
  return { pk: teamRecordPk(orgId, project), sk: `SOURCE#${keyPart(system, "a source system")}#${teamRecordSourceHash(system, scope)}` };
}
export const RECORD_SOURCE_SK_PREFIX = "SOURCE#";
export function memorySnapshotKey(orgId: OrgId, project: string, snapshotId: string): OrgKey {
  return { pk: teamRecordPk(orgId, project), sk: `SNAPSHOT#${keyPart(snapshotId, "a snapshot id")}` };
}
/** The company lock on the learning mode, in the workspace's own (project-less) partition. */
export function learningModeLockKey(orgId: OrgId): OrgKey {
  return { pk: teamRecordPk(orgId), sk: "MODE_LOCK" };
}
/** A queued delete of rows hidden at a source (a tombstone request the delete worker finishes), in the workspace's own partition. */
export function recordDeleteQueueKey(orgId: OrgId, at: string, requestId: string): OrgKey {
  return { pk: teamRecordPk(orgId), sk: `DELQ#${canonicalInstant(at)}#${keyPart(requestId, "a request id")}` };
}
export const RECORD_DELETE_QUEUE_SK_PREFIX = "DELQ#";
/** The project's learning mode (Off, Collect, Suggest, On), where the settings writer stores it. */
export function learningModeKey(orgId: OrgId, project: string): OrgKey {
  return { pk: teamRecordPk(orgId, project), sk: "MODE" };
}
