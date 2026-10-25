// Multi-tenancy: the DynamoDB keys whose names two orgs can share (a project called "web", a member
// grant on it, the workspace limits) or that list across tenants (the usage and failure indexes).
// Each one is prefixed with `orgScoped(orgId, ...)`, and nothing else builds these keys.
import { canonicalInstant, indexDay } from "./admin.js";
import type { AgentId } from "./agent.js";
import type { AgentPrincipal, ApprovalId, SkillId } from "./agent-node.js";
import type { DeviceId, SessionBinding, SessionId } from "./agent-sessions-node.js";
import { OrgIdSchema, type OrgId } from "./org.js";
import { orgScoped, type OrgKey } from "./org-node.js";
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

export type OrgSettingName = "WORKSPACE_LIMITS" | "BUDGET" | "BUDGET_SYNCED" | "SPEND_POLICY" | "LOCAL_AGENTS";

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
  | `EVENT#${string}`
  | `BINDING#${string}`
  | `LEG#${string}`
  | `TAKE_OVER_FOLLOW_UP#${string}`
  | `REQUEST#${string}`
  | "RETRIED";

/** One session's partition: its META header, shares, followers, who is looking now, messages, local turns, events, bindings, legs and the marks a take-over owes (`TAKE_OVER_FOLLOW_UP#<approvalId>`), the requests a stop or retry answered (`REQUEST#<requestId>`) and the one retry a session had (`RETRIED`). */
export function agentSessionKey(orgId: OrgId, sessionId: SessionId, sk: AgentSessionItemSk): OrgKey {
  return { pk: orgScoped(orgId, `AGENT_SESSION#${keyPart(sessionId, "a session id")}`), sk };
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
export function sessionRateKey(orgId: OrgId, sessionId: SessionId, developerId: string, kind: "comment" | "change" | "steer" | "steer_all"): OrgKey {
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

/** A Home card one person dismissed. */
export function homeDismissKey(orgId: OrgId, developerId: string, cardId: string): OrgKey {
  return { pk: orgScoped(orgId, `HOME_DISMISS#${keyPart(developerId, "a developer id")}`), sk: keyPart(cardId, "a card id") };
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

/** One command waiting for a device (stop, move to the cloud, a steering message); six digits keep them in order. */
export function deviceCommandKey(orgId: OrgId, deviceId: DeviceId, seq: number): OrgKey {
  return { pk: devicePk(orgId, deviceId), sk: `COMMAND#${paddedCounter(seq, "a command number")}` };
}
