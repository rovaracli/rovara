// Plan 3 Task 21: what happens to an agent's connector call once it is classified (Task 20b). A `read` and a `safe` call run; a call a project deny rule
// matches is refused; a `consequential` or `merge` call is stored as one WriteApprovalRecord holding exactly the prepared arguments, and the run waits
// for a person (Task 21a's confirmation page). When a person approves, `executeWrite` re-checks everything against live data, in order, and then runs
// exactly the stored arguments through the connector call path (injected as `WriteGateRuntime.runConnector`: Task 19 builds it from `callConnector`)
// under a request id derived from the approval, so the ledger replays a result instead of calling the vendor twice. The decision itself, the
// record's states, the sweep and the movers are approvals.ts's; this file is what is specific to a write.
import { createHash } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  DEVELOPER_EVENT_TEXT_MAX,
  MAX_PENDING_APPROVALS_PER_STEP,
  OrgIdSchema,
  AgentXError,
  ApprovalIdSchema,
  ConnectorCallRequestSchema,
  agentXError,
  canonicalJson,
  capText,
  describeAction,
  projectAllows,
  type ApprovalRules,
  type ActionPolicy,
  type AuditProof,
  type Autonomy,
  type ConnectorCallRequest,
  type ConnectorResult,
  type GrantedTool,
  type OrgId,
  type StoredProjectDefinition,
} from "@agentx/contracts";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { readProjectMeta } from "../developer/project-roles.js";
import { requireCreatorStillMember } from "../developer/creator-member.js";
import { effectiveTaskOwner, taskKey, taskPointerKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { latestRevision } from "../org/project-settings.js";
import { orgRoleOf, type AgentCaller } from "./access.js";
import {
  approvalIdFromSeed, approvalTaskEventKey, createWriteApprovalRecord, getAnyApproval, registerApproverRule, registerWriteApprovalDriver, requireRegisteredApprovers,
  runApprovalDecision, runOfApproval, shownText,
  type ApprovalDependencies, type ApproverSpec, type Execution, type WriteApprovalRecord,
} from "./approvals.js";
import { WRITE_APPROVAL_TTL_MS } from "./approval-ttl.js";
import type { TransactItem } from "./approvals-store.js";
import { resolveMember, sameMember } from "./lifecycle.js";
import { classifyAgentWrite, recordOwnItems, type ClassifyAgentWriteDependencies, type WriteClassification } from "./write-class.js";

export const WRITE_APPROVER_RULE = "write_approver";

const SHAPE_CHECK_REQUEST_ID = "00000000-0000-4000-8000-000000000000";
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const STEP = /^[a-z][a-z0-9_]{0,23}$/;

// ---- the exact words

export const STEP_ENDED_TEXT = "This step has already finished, so this action was not started.";
export const TOO_MANY_PENDING_TEXT = "Too many actions are waiting for approval in this step. Finish with a report instead.";
const REFUSED_BY_RULE_TEXT = "A rule on this project doesn't allow this action.";
const ALREADY_DECIDED_TEXT = "A person already decided this action. Carry on with the rest of your work.";
const NOT_AVAILABLE_TEXT = "This tool isn't available for this project right now.";
const OTHER_REPOSITORY_TEXT = "That repository isn't one of this project's repositories.";
export const CONNECTOR_CHANGED_TEXT = "The connector changed since this was asked, so Rovara didn't run it.";
const TASK_ENDED_TEXT = "The task ended before this was approved, so Rovara didn't run it.";
const PROJECT_ARCHIVED_TEXT = "The project is archived, so Rovara didn't run it.";
const NO_AUTHORITY_TEXT = "The person who started this no longer has access to the project, so Rovara didn't run it.";
const TOOL_NOT_APPROVED_TEXT = "The project no longer approves this tool, so Rovara didn't run it.";
const RULE_DENIES_TEXT = "A project rule no longer allows this, so Rovara didn't run it.";

/** What the model is told when a call waits. */
export const waitingForApprovalAnswer = (ownerName: string): { status: "WAITING_FOR_APPROVAL"; text: string } => ({
  status: "WAITING_FOR_APPROVAL",
  text: `A person must approve this before it happens. Rovara has asked ${ownerName} and the project's maintainers. Carry on with the rest of your work; you'll hear the outcome.`,
});

// ---- what the gate needs from the deployment

/** The agent-side inputs the classifier reads (Task 20b); Task 19 reads them live: the recipe's approval rules and autonomy, the snapshot's `allowMentions`, the project's policy and the org's guardrails. */
export interface ClassifyContext {
  rules: ApprovalRules;
  autonomy: Autonomy;
  allowMentions: boolean;
  projectPolicy?: ActionPolicy | undefined;
  guardrails?: { extraCommandWords: readonly string[]; extraTriggerLabels: readonly string[] } | undefined;
}

/**
 * `classifyArgs` are the arguments classification and the own-item record read: the call's own plus the values the server binds that the stored call
 * does not hold (a GitHub call's `owner` and `repo`, which the gateway refuses from a model). Absent: the stored arguments.
 */
export type Regranted = { tool: GrantedTool; classify: ClassifyContext; classifyArgs?: Record<string, unknown> } | { refused: string };

/** One approved call, with everything `callConnector` needs besides the ledger and the catalogs. The task's own workspace id and owner key come from its record. */
export interface ApprovedCall {
  orgId: OrgId;
  project: string;
  taskId: string;
  workspaceId: string;
  /** The task's owner key: the identity the connector context and the project authority check use. */
  ownerKey: string;
  /** The person the run belongs to (the connector call's attribution). */
  requestedBy: string;
  /** The agent's name as the approver was shown it (the attribution footer names it). */
  agentName: string;
  /** The project's name for the connector. */
  connector: string;
  /** The project's CURRENT revision, from which the connector context is rebuilt (the record's `projectRevision` is for display). */
  definition: StoredProjectDefinition;
  runtimeBinding: unknown;
  /** `requestId` is `deriveWriteRequestId(approvalId)`: the same on every attempt, so a retry replays the ledger's result. */
  request: ConnectorCallRequest;
}

/**
 * What a write approval needs beyond the table. Task 19 builds it: `runConnector` is `callConnector` with a `WorkspaceInstance` read from the
 * workspace record (no live workspace is needed), the connector context from `definition` and a ledger of the workspace; `regrant` re-resolves the
 * agent's grant from the run's frozen recipe against the current revision and reads the classifier's live inputs; `requireRunAuthority` is
 * `requireProjectAuthority` for the task's owner key.
 */
export interface WriteGateRuntime {
  classify: ClassifyAgentWriteDependencies;
  runConnector(call: ApprovedCall): Promise<ConnectorResult>;
  regrant(input: { record: WriteApprovalRecord; definition: StoredProjectDefinition }): Promise<Regranted>;
  requireRunAuthority(input: { orgId: OrgId; ownerKey: string; project: string; taskId: string }): Promise<void>;
  /**
   * What the connector ledger recorded for a request id (`DynamoConnectorLedger.get`), without calling the vendor. A retry asks it first: a call that
   * already ran is reported as done even if the task was cancelled since, because nothing is left to stop. Without it a retry re-checks as a first attempt does.
   */
  recordedResult(input: { orgId: OrgId; workspaceId: string; connector: string; requestId: string }): Promise<ConnectorResult | undefined>;
  /** Whether `caller` can view the task (Task 22 wires the task page's own access check). Without it only an approver or the task's owner sees an approval. */
  canViewTask?(caller: AgentCaller, task: { taskId: string; project: string; developerId: string }): Promise<boolean>;
}

/** Who is deciding, and what to do with their session afterwards: `finish` once a decision was made, `release` when it was refused (M-d). */
export interface DecideAuthority {
  orgId: OrgId;
  developerId: string;
  proof: AuditProof;
  finish(): Promise<void>;
  release(): Promise<void>;
}

/**
 * Task 21a-wiring: the presence guard (`requireDecideSession`) in front of every decide route. A token is refused with `REAUTH_REQUIRED` and a
 * `confirmUrl` (thrown); a browser session opened for this approval, signed in within 10 minutes, with the cell's Origin and its CSRF field,
 * is returned. Without a guard the decide routes answer 404. The broker sets it on `ApprovalDependencies.requireDecide`.
 */
export type DecideGuard = (request: AdaptedHttpRequest, approvalId: string) => Promise<DecideAuthority>;

export interface DecideWriteInput {
  orgId: OrgId;
  taskId: string;
  operationId: string;
  stepId: string;
  /** The agent that is asking, as it is named now: stored on the approval so the page shows what was asked of whom, even if the agent is renamed. */
  agentId: string;
  agentName: string;
  tool: GrantedTool;
  /** `arguments` are the PREPARED arguments (`prepareAgentWrite`'s): the approval holds exactly what will be sent. */
  call: { scope: string; schemaHash: string; arguments: Record<string, unknown> };
  classify: ClassifyContext;
  /**
   * What the caller already classified, on the arguments the server binds as well (the agent tools route does: it reads label lists and the run's own items
   * with the run in hand). Absent: the call is classified here, on `call.arguments`.
   */
  classification?: WriteClassification;
  run: { project: string; owner: { developerId: string; name: string } };
  /**
   * Claims the call's request id for the approval, in the transaction that makes it (a conditional put, so it fails if the id is taken). When the id is taken
   * nothing is made and the answer is `replay`: the caller answers from what the claim holds. Absent: the request id is not claimed.
   */
  claimRequest?: (approvalId: string) => TransactItem;
  /**
   * A condition on the operation that is asking (a `ConditionCheck` that it has not ended), in the approval's own transaction: a step that ended between the
   * caller's check and this write makes no approval, so a step is never done with a PENDING approval its result did not see (Task 22 review, M2). Absent: no check.
   */
  operationGuard?: TransactItem;
  /** Defaults to the `write_approver` rule with `writeApproversFor` as its candidates; Plan 4 passes `chain_autonomous_writer`. */
  approvers?: ApproverSpec;
}

export type WriteDecision =
  | { outcome: "run" }
  | { outcome: "wait"; approvalId: string; answer: { status: "WAITING_FOR_APPROVAL"; text: string } }
  | { outcome: "refuse"; reason: string }
  /** The call's request id was already claimed (by a run or another hold): nothing was made, and the caller replays what the claim holds. */
  | { outcome: "replay" };

// ---- ids, people

/** The connector ledger's request id for an approval: a UUID made from the approval id alone, so every attempt, here or in a retry, asks the ledger the same thing. */
export function deriveWriteRequestId(approvalId: string): string {
  const bytes = createHash("sha256").update(`rovara-write-request:${approvalId}`, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The run's owner and every holder of `approve_writes` on the project, each as the member they are now: who is shown the approval. The rule decides who may decide. */
export async function writeApproversFor(deps: ApprovalDependencies, run: { orgId: OrgId; project: string; owner: { developerId: string } }): Promise<string[]> {
  const people = new Set<string>([await resolveMember(deps, run.orgId, run.owner.developerId)]);
  for (const member of await deps.projectMembers.list(run.orgId, run.project)) {
    if (projectAllows(member.role, "approve_writes")) people.add(await resolveMember(deps, run.orgId, member.developerId));
  }
  return [...people];
}

// The run's owner while they hold `start_tasks` on the project, or anyone who holds `approve_writes` on it now: both read live at decision time.
registerApproverRule(WRITE_APPROVER_RULE, async (deps, record, caller) => {
  const run = await runOfApproval(deps, record);
  if (run === undefined) return false;
  const orgRole = await orgRoleOf(deps, record.orgId, caller.developerId);
  if (orgRole === undefined) return false;
  const role = await deps.projectMembers.roleOf(record.orgId, run.project, { developerId: await resolveMember(deps, record.orgId, caller.developerId), orgRole });
  if (role === undefined) return false;
  if (projectAllows(role, "approve_writes")) return true;
  return projectAllows(role, "start_tasks") && await sameMember(deps, record.orgId, run.owner.developerId, caller.developerId);
});

// ---- the project's connector, as the current revision stores it

interface StoredConnector { type: string; credentialRef?: string; scopes?: unknown; tools: Array<{ name: string; access: "read" | "write" }> }

function connectorOf(definition: StoredProjectDefinition, name: string): StoredConnector | undefined {
  const legacy = definition.integrations?.githubMcp;
  if (legacy !== undefined) return name === "github" ? { type: "github", scopes: "all-repositories", tools: legacy.tools } : undefined;
  return (definition.integrations?.connectors ?? []).find((entry) => entry.name === name) as StoredConnector | undefined;
}

/** What the connector's scope called `alias` is, as stored: a digest of it, so a scope that kept its name and pointed somewhere else is not the one a person approved. Undefined when there is no such scope. */
function scopeDigestOf(definition: StoredProjectDefinition, connector: StoredConnector, alias: string): string | undefined {
  const scopes = connector.scopes;
  let found: unknown;
  if (connector.type === "github") {
    const named = scopes === "all-repositories" || (Array.isArray(scopes) && scopes.includes(alias));
    const repository = definition.repositories.find((entry) => entry.name === alias);
    found = named && repository !== undefined ? { repository: { name: repository.name, url: repository.url } } : undefined;
  } else if (Array.isArray(scopes)) {
    found = scopes.find((scope) => typeof scope === "object" && scope !== null && (scope as { alias?: unknown }).alias === alias);
  }
  return found === undefined ? undefined : createHash("sha256").update(canonicalJson(found), "utf8").digest("hex");
}

/** The repository a GitHub connector's scope names, as `owner/name` in the case the project stores it; undefined for any other connector or a scope that names none. */
function scopeRepositoryName(definition: StoredProjectDefinition, connector: StoredConnector, alias: string): string | undefined {
  if (connector.type !== "github") return undefined;
  const url = definition.repositories.find((entry) => entry.name === alias)?.url;
  const found = url === undefined ? undefined : /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  return found === null || found === undefined ? undefined : `${found[1]!}/${found[2]!}`;
}

// ---- GitHub: the call's own repository

const repositoryFullName = (url: string): string | undefined => /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url)?.slice(1, 3).join("/").toLowerCase();

function callRepository(args: Record<string, unknown>): string | undefined {
  const { owner, repo } = args;
  return typeof owner === "string" && typeof repo === "string" && owner.trim() !== "" && repo.trim() !== "" ? `${owner.trim()}/${repo.trim()}`.toLowerCase() : undefined;
}

/** For a GitHub call that names a repository: that repository (it must be one of the project's, read now) and its pinned installation. `refused` otherwise, also when the list can't be read. */
async function githubRepositoryOf(deps: ApprovalDependencies, orgId: OrgId, project: string, tool: GrantedTool, args: Record<string, unknown>): Promise<{ repository?: string; installationId?: number } | "refused"> {
  if (tool.type !== "github") return {};
  const named = callRepository(args);
  if (named === undefined) return {};
  if (deps.projectRepositories === undefined) return "refused";
  const entries = await deps.projectRepositories(orgId, project);
  const match = entries?.find((entry) => repositoryFullName(entry.url) === named);
  return match === undefined ? "refused" : { repository: named, ...(match.installationId === undefined ? {} : { installationId: match.installationId }) };
}

// ---- deciding a call

function gateOf(deps: ApprovalDependencies): WriteGateRuntime {
  if (deps.writeGate === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "writes by agents are not set up in this deployment");
  return deps.writeGate;
}

/**
 * What a write approval says now, for a call that was held under it: a pending or executing one waits, a done one has its result, any other is decided. Undefined
 * when there is no such write approval.
 */
export async function answerForHeldCall(deps: ApprovalDependencies, orgId: OrgId, approvalId: string): Promise<{ kind: "wait"; text: string } | { kind: "result"; result: NonNullable<WriteApprovalRecord["result"]> } | { kind: "decided"; text: string } | undefined> {
  const record = OrgIdSchema.safeParse(orgId).success && ApprovalIdSchema.safeParse(approvalId).success ? await getAnyApproval(deps, orgId, approvalId) : undefined;
  if (record?.kind !== "write") return undefined;
  if (record.status === "PENDING" || record.status === "EXECUTING") return { kind: "wait", text: waitingForApprovalAnswer(shownText(record.owner.name, 80)).text };
  if (record.status === "APPROVED_DONE" && record.result !== undefined) return { kind: "result", result: record.result };
  return { kind: "decided", text: ALREADY_DECIDED_TEXT };
}

function answerForExisting(record: WriteApprovalRecord): WriteDecision {
  return record.status === "PENDING" || record.status === "EXECUTING"
    ? { outcome: "wait", approvalId: record.approvalId, answer: waitingForApprovalAnswer(shownText(record.owner.name, 80)) }
    : { outcome: "refuse", reason: ALREADY_DECIDED_TEXT };
}

const lowerFirst = (text: string): string => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

/**
 * What a call of an agent does now. `read` and `safe` run; a project deny rule refuses (also a read); `consequential` and `merge` make a PENDING write
 * approval, idempotent per (operation, tool, arguments), with one task event, in one transaction, and wait. Beyond `MAX_PENDING_APPROVALS_PER_STEP`
 * pending approvals in the step the call is refused. The class comes from `classifyAgentWrite`, which fails closed on any lookup that breaks.
 */
export async function decideWrite(deps: ApprovalDependencies, input: DecideWriteInput): Promise<WriteDecision> {
  const gate = gateOf(deps);
  if (!OrgIdSchema.safeParse(input.orgId).success || !ID.test(input.taskId) || !ID.test(input.operationId) || !STEP.test(input.stepId)) {
    throw agentXError("CONFIG_INVALID", "the task, operation or step is not a valid id");
  }
  const { tool, call, run } = input;
  // The call must be one the connector path would accept, so what is stored is something that can be run (and read back).
  const shape = ConnectorCallRequestSchema.safeParse({ requestId: SHAPE_CHECK_REQUEST_ID, scope: call.scope, tool: tool.upstreamName, schemaHash: call.schemaHash, arguments: call.arguments });
  if (!shape.success) throw agentXError("CONFIG_INVALID", `call.${shape.error.issues[0]?.path.join(".") || "arguments"}: is not valid`);
  const found = await githubRepositoryOf(deps, input.orgId, run.project, tool, call.arguments);
  if (found === "refused") return { outcome: "refuse", reason: OTHER_REPOSITORY_TEXT };

  const classification = input.classification ?? await classifyAgentWrite(gate.classify, {
    orgId: input.orgId, taskId: input.taskId, project: run.project, tool, args: call.arguments, ...input.classify,
    ...(found.repository === undefined ? {} : { repository: found.repository }), ...(found.installationId === undefined ? {} : { installationId: found.installationId }),
  });
  if (classification.denied !== undefined) return { outcome: "refuse", reason: REFUSED_BY_RULE_TEXT };

  // An approval already made for this very call (same operation, connector, scope, tool and arguments) answers whatever the class is now: a lookup that failed
  // the first time, or a rule changed since, can make the same call safe on the next try, and running it then would send it a second time under another request
  // id when the person approves the first.
  const argumentsHash = createHash("sha256").update(canonicalJson(call.arguments), "utf8").digest("hex");
  const approvalId = approvalIdFromSeed(input.orgId, `write|${input.operationId}|${tool.connector}|${call.scope}|${tool.upstreamName}|${argumentsHash}`);
  const earlier = await getAnyApproval(deps, input.orgId, approvalId);
  if (earlier?.kind === "write") return answerForExisting(earlier);
  if (classification.class === "read" || classification.class === "safe") return { outcome: "run" };

  const approvers = input.approvers ?? { kind: "rule" as const, rule: WRITE_APPROVER_RULE, candidates: await writeApproversFor(deps, { orgId: input.orgId, project: run.project, owner: run.owner }) };
  requireRegisteredApprovers(approvers);


  // The connector, scope and tool as the project stores them now: what a person is shown is what will be checked again when they approve.
  const latest = await latestRevision(deps, input.orgId, run.project);
  const connector = latest === undefined ? undefined : connectorOf(latest.definition, tool.connector);
  const approved = connector?.tools.find((entry) => entry.name === tool.upstreamName);
  const scopeDigest = latest === undefined || connector === undefined ? undefined : scopeDigestOf(latest.definition, connector, call.scope);
  if (latest === undefined || connector === undefined || approved === undefined || scopeDigest === undefined) return { outcome: "refuse", reason: NOT_AVAILABLE_TEXT };

  const now = deps.now();
  const createdAt = new Date(now).toISOString();
  const ownerName = shownText(run.owner.name, 80);
  const repository = scopeRepositoryName(latest.definition, connector, call.scope);
  const summary = describeAction(tool.presentedName, call.arguments);
  const record: WriteApprovalRecord = {
    orgId: input.orgId, approvalId: approvalId, kind: "write",
    subject: { kind: "agent_run", taskId: input.taskId, stepId: input.stepId }, operationId: input.operationId,
    connector: tool.connector, connectorType: tool.type, tool: tool.upstreamName, toolAccess: approved.access, scope: call.scope, ...(repository === undefined ? {} : { repository }), schemaHash: call.schemaHash,
    projectRevision: latest.definition.revision, ...(connector.credentialRef === undefined ? {} : { credentialRef: connector.credentialRef }), scopeDigest,
    arguments: call.arguments, argumentsHash, summary, class: classification.class,
    approvers, status: "PENDING", project: run.project, owner: { developerId: run.owner.developerId, name: ownerName },
    agent: { agentId: input.agentId, name: shownText(input.agentName, 80) },
    attempts: 0, createdAt, expiresAt: new Date(now + WRITE_APPROVAL_TTL_MS).toISOString(),
  };
  const text = capText(`${shownText(input.agentName, 80)} wants to ${lowerFirst(shownText(summary, 300))}. This needs approval from ${ownerName} or a project maintainer.`, DEVELOPER_EVENT_TEXT_MAX).text;
  const event = { Put: { TableName: deps.tableName, Item: { ...approvalTaskEventKey(input.taskId, createdAt, approvalId), entityType: "TASK_EVENT", orgId: input.orgId, kind: "status", text, at: createdAt } } };
  const claim = input.claimRequest?.(approvalId);
  const extraItems = [event, ...(claim === undefined ? [] : [claim]), ...(input.operationGuard === undefined ? [] : [input.operationGuard])];
  const made = await createWriteApprovalRecord(deps, record, extraItems, MAX_PENDING_APPROVALS_PER_STEP, claim === undefined ? undefined : 1, input.operationGuard === undefined ? undefined : extraItems.length - 1);
  if (made === "full") return { outcome: "refuse", reason: TOO_MANY_PENDING_TEXT };
  if (made === "ended") return { outcome: "refuse", reason: STEP_ENDED_TEXT };
  if (made === "claimed") return { outcome: "replay" };
  if (made === "exists") {
    // Two copies of one call racing: the one that lost answers what the winner made.
    const winner = await getAnyApproval(deps, input.orgId, approvalId);
    if (winner?.kind === "write") return answerForExisting(winner);
    throw agentXError("CONFIG_INVALID", "this approval id is already in use");
  }
  return { outcome: "wait", approvalId, answer: waitingForApprovalAnswer(ownerName) };
}

// ---- carrying out an approved write

async function readTask(deps: ApprovalDependencies, record: WriteApprovalRecord): Promise<DeveloperTaskRecord | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(record.subject.taskId), ConsistentRead: true })) as { Item?: DeveloperTaskRecord };
  // A task partition is global: the record's org is re-checked on the item.
  return response.Item?.orgId === record.orgId ? response.Item : undefined;
}

/** Whether the task is over: closed, ended by a removal, cancelled before its instructions ran, or its agent run finished or was cancelled. */
async function taskEnded(deps: ApprovalDependencies, task: DeveloperTaskRecord): Promise<boolean> {
  if (task.closedAt !== undefined || task.outcome !== undefined) return true;
  const read = async (key: { pk: string; sk: string }) => (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
  const [pointer, run] = await Promise.all([read(taskPointerKey(task.workspaceId)), read({ pk: `DEVTASK#${task.taskId}`, sk: "AGENT_RUN" })]);
  if (pointer?.["cancelledAt"] !== undefined) return true;
  return run !== undefined && run["orgId"] === task.orgId && ["COMPLETE", "FAILED", "CANCELLED"].includes(String(run["state"]));
}

const failed = (failure: string): Execution => ({ outcome: "failed", failure });
const unconfirmedText = (connector: string): string => `Rovara couldn't confirm that this ran. Check ${connector} before asking again.`;
const refusalText = (error: AgentXError): string => shownText(error.message.startsWith(`${error.code}: `) ? error.message.slice(error.code.length + 2) : error.message, 300);

/**
 * The re-checks, in order, then the call. Everything is read live and from the project's CURRENT revision: the task is not over; its creator is still a
 * member (`requireCreatorStillMember`, which ends the task `creator_removed`); the project is not archived; the run owner still has the project's
 * authority; the connector's credential and scope are what a person was shown; the project still approves the tool; the agent still holds the grant; and
 * the class, classified again, is not refused (it may rise, never fall). Then the connector call, under the request id derived from the approval, so a
 * retry replays the ledger's result instead of calling the vendor again.
 */
export async function executeWrite(deps: ApprovalDependencies, record: WriteApprovalRecord): Promise<Execution> {
  const gate = gateOf(deps);
  const task = await readTask(deps, record);
  if (task === undefined) return failed(TASK_ENDED_TEXT);
  // A retry after a crash may find that the call already ran: then there is nothing left to check or to stop, only to report.
  const requestId = deriveWriteRequestId(record.approvalId);
  if ((record.attempts ?? 0) > 1) {
    const recorded = await gate.recordedResult({ orgId: record.orgId, workspaceId: task.workspaceId, connector: record.connector, requestId });
    if (recorded?.status === "SUCCEEDED") return { outcome: "done", result: { status: recorded.status, text: capText(recorded.text, 16_000).text, truncated: recorded.truncated, replayed: true } };
    // The ledger holds a claim or an unknown outcome: the vendor may have acted, so "didn't run" would be a guess. Nothing more is sent.
    if (recorded?.status === "IN_PROGRESS" || recorded?.status === "UNKNOWN") return failed(unconfirmedText(record.connector));
  }
  if (await taskEnded(deps, task)) return failed(TASK_ENDED_TEXT);
  try {
    await requireCreatorStillMember({ documentClient: deps.documentClient, tableName: deps.tableName, orgId: record.orgId, now: deps.now }, task);
  } catch (error) {
    if (error instanceof AgentXError) return failed(refusalText(error));
    throw error;
  }
  if ((await readProjectMeta(deps, record.orgId, record.project))?.status === "archived") return failed(PROJECT_ARCHIVED_TEXT);
  try {
    await gate.requireRunAuthority({ orgId: record.orgId, ownerKey: task.ownerKey, project: record.project, taskId: task.taskId });
  } catch (error) {
    if (error instanceof AgentXError && error.code !== "RUNTIME_UNAVAILABLE") return failed(NO_AUTHORITY_TEXT);
    throw error;
  }

  const latest = await latestRevision(deps, record.orgId, record.project);
  if (latest === undefined) return failed(CONNECTOR_CHANGED_TEXT);
  const connector = connectorOf(latest.definition, record.connector);
  if (connector === undefined || connector.type !== record.connectorType || connector.credentialRef !== record.credentialRef
    || scopeDigestOf(latest.definition, connector, record.scope) !== record.scopeDigest) return failed(CONNECTOR_CHANGED_TEXT);
  const approval = connector.tools.find((entry) => entry.name === record.tool);
  if (approval === undefined || (record.toolAccess === "write" && approval.access !== "write")) return failed(TOOL_NOT_APPROVED_TEXT);

  const regranted = await gate.regrant({ record, definition: latest.definition });
  if ("refused" in regranted) return failed(shownText(regranted.refused, 300));
  // Classified on the arguments the server binds as well (a GitHub call's owner and repo), as the call was when it was asked.
  const classifyArgs = regranted.classifyArgs ?? record.arguments;
  const found = await githubRepositoryOf(deps, record.orgId, record.project, regranted.tool, classifyArgs);
  if (found === "refused") return failed(OTHER_REPOSITORY_TEXT);
  const classification = await classifyAgentWrite(gate.classify, {
    orgId: record.orgId, taskId: record.subject.taskId, project: record.project, tool: regranted.tool, args: classifyArgs, ...regranted.classify,
    ...(found.repository === undefined ? {} : { repository: found.repository }), ...(found.installationId === undefined ? {} : { installationId: found.installationId }),
  });
  if (classification.denied !== undefined) return failed(RULE_DENIES_TEXT);

  const result = await gate.runConnector({
    orgId: record.orgId, project: record.project, taskId: task.taskId, workspaceId: task.workspaceId, ownerKey: task.ownerKey, requestedBy: effectiveTaskOwner(task).developerId, agentName: record.agent?.name ?? "this agent",
    connector: record.connector, definition: latest.definition, runtimeBinding: latest.runtimeBinding,
    request: { requestId, scope: record.scope, tool: record.tool, schemaHash: record.schemaHash, arguments: record.arguments },
  });
  if (result.status === "FAILED") return failed(`The connector didn't run it: ${shownText(result.text, 300)}`);
  if (result.status !== "SUCCEEDED") return { outcome: "unfinished" };
  // A create that ran makes the item the run's own, so a later change to it needs no approval. The create already happened: a lost record only makes a later change ask.
  await recordOwnItems(gate.classify, { orgId: record.orgId, taskId: task.taskId, tool: regranted.tool, args: classifyArgs, resultText: result.text });
  return { outcome: "done", result: { status: result.status, text: capText(result.text, 16_000).text, truncated: result.truncated, replayed: result.replayed } };
}

registerWriteApprovalDriver({ execute: (deps, record) => executeWrite(deps, record) });

/** Decides a write approval as `caller` (the same decision `decideApproval` makes for a record of this kind). */
export async function decideWriteApproval(
  deps: ApprovalDependencies,
  caller: AgentCaller,
  approvalId: string,
  body: unknown,
): Promise<{ status: WriteApprovalRecord["status"] }> {
  const id = ApprovalIdSchema.safeParse(approvalId);
  const record = id.success ? await getAnyApproval(deps, caller.orgId, id.data) : undefined;
  if (record?.kind !== "write") throw agentXError("NOT_FOUND", "approval not found");
  return runApprovalDecision(deps, caller, record, body);
}
