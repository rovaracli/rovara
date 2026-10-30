import { nativeSnapshotConditions } from "../org/native-snapshot-conditions.js";
import { OwnerFinancialTermsSchema, ownerFinancialChecks, assertOwnerCarriedSource, ownerApprovalTermsComplete } from "./owner-approval-terms.js";
import { grantRoleOf } from "../developer/project-roles.js";
import { requireNativeProjectWorkRole } from "../developer/task-access.js";
import { taskRunLimitMicrousd, makeTaskApprovalTerms, TaskApprovalTermsSchema, taskApprovalPolicyDigest, taskApprovalRecordMatches, taskApprovalSourceMatches, pinTaskApprovalSource, pinTaskApprovalRequest, type TaskApprovalTerms } from "./task-approval-terms.js";
import { approveCapturedTaskStop, captureTaskStopAdmission, previewTaskStopCutover, captureTaskStopCutoverReview, type CapturedTaskStop } from "../org/task-stop-admission.js";
import { savedTaskStopBounds, checkedTaskStopSnapshot, withAdmittedTaskSource, type PreparedTaskApprovalAdmission } from "../org/task-stop-window.js";
import { usdToWholeMicrodollars } from "../org/budget-amount.js";
import { ApprovalSourceSchema, sourceFields, sourceCondition, staleApproval, type ApprovalSource } from "./approval-source.js";
import type { BudgetSubject } from "./owner-total.js";
import { budgetActorChecks, budgetActorRefused, type BudgetActor } from "../agents/budget-authority.js";
// Plan 3 Task 32: requests for more spend. A run that reached one of its own limits (its run limit, the agent's max per run, the planning limit) asks the person
// who may raise it; an agent budget change that would take one person past the owner cap asks an org admin. A request is one record (`spendRequestKey`) with
// the org's open index item, a global due item for the settlement run, and a slot per subject and kind, so a second pause asks for nothing new. Who may decide
// is read live (`spendApprovers`, R68), never from the stored list, which is kept for the lists and the movers. Deciding goes only through the confirmation
// page (Task 21a's `requireDecideSession`, R66); an approval changes the limit in the same transaction that ends the request, and then the task goes on where
// it stopped (`SpendRequestHost.resumeTask`, which is `resumeTaskAfterSpendApproval` in developer-tasks.ts).
import { taskResponseForClient } from "../rovara-code/task-view-compat.js";
import { createHash } from "node:crypto";
import { DeleteCommand, GetCommand, QueryCommand, TransactGetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  projectMemberKey, agentKey, chainKey, builtinSettingsKey, AgentIdSchema, AgentXError, ChainIdSchema, orgSettingsKey, PER_TASK_BUDGET_USD, SPEND_REQUEST_REASON_MAX, SPEND_REQUEST_TTL_DAYS, OWNER_ANSWER_HOURS, SpendRequestIdSchema, agentXError, isBuiltinAgentId, ROVARA_CODE_AGENT_ID,
  newPrefixedId, openSpendRequestDueKey, openSpendRequestsKey, orgPk, ownerBudgetKey, pauseKey, pausedTasksKey, scopeKey, spendRequestKey, spendRequestSlotKey,
  suggestedMonthTopUpUsd, suggestedTopUpUsd, topUpKey, INDEX_EXPIRY_ATTRIBUTE, developerOrgKey, orgMetaKey, orgMemberKey, orgRemovedKey, isRunLimitBlockReason, RUN_LIMIT_ASK_COOLDOWN_MS, heldPlanStartKey, planRunLimitSubject, runLimitAskedKey, spendCounterKey,
  SpendingAdmissionReferenceSchema, type SpendingAdmissionReference, type AuditEventInput, type AuditProof, type BudgetScope, type OrgId, type OwnerCapChange, type PauseScope, type SpendApproverRole, type SpendRequestKind, type SpendRequestRecord,
} from "@agentx/contracts";
import { orgRoleOf, requireAccountable, requireAgentAccess, requireAgentBudgetAllowed, requireOwnerAllowed, resolveSurvivor, type AgentCaller } from "../agents/access.js";
import { requireChainAccess, requireChainAccountable, requireChainBudgetAllowed, requireChainOwnerAllowed } from "../chains/access.js";
import { roleOnProject } from "../agents/roster.js";
import { isRovaraCodeTask } from "../agents/rovara-code-task.js";
import { StatusReply } from "../aws/status-reply.js";
import { budgetOwnerOf, ownerVersionItem, withBudgetFields } from "./owner-total.js";
import { readGuardrails } from "../agents/guardrails.js";
import { askedRunLimit, type RequestRunLimit, type RunLimitRequest } from "./estimate.js";
import { writeChanges } from "../realtime/changes.js";
import { checkTime, registerMemberMover, registerOwnerCapConfirmation, type LifecycleDeps } from "../agents/lifecycle.js";
import type { AgentRouteDependencies } from "../agents/routes.js";
import { failedIndexes, readRequest, requestMarkItem, type RequestMark, type TransactItem } from "../agents/table-writes.js";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { auditSpendRequestCreated, auditSpendRequestDecided, auditSpendRequestEscalated, auditSpendRequestExpired, auditSpendRequestRerouted, auditSpendRequestResumeDropped, auditOccurrence } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents } from "../audit/outbox.js";
import { auditActorOf, centsOf, decisionProofOf } from "../audit/plan3-hooks.js";
import type { ConfirmView, DecideInspection, DecideKind, DecideOutcome, DecideTarget } from "../developer/decide-kinds.js";
import { endOfFailure, settleSession, type DecisionEnd } from "../developer/decide-session.js";
import { effectiveTaskOwner, isTaskTakenOver, taskKey, tryEffectiveTaskOwner, type DeveloperTaskRecord, type TaskOwnerSource } from "../developer/task-records.js";
import { effectiveLimits, decodeSpendPolicySnapshot, readSpendPolicy, readSpendPolicyWithRevision } from "./settings.js";
import { cleanUsd, readTopUp } from "./top-ups.js";

/** What the broker does for a request once it is approved: the parts that live with the developer tasks. */
export interface SpendRequestHost {
  /** Goes on with a task whose limit was raised (`resumeTaskAfterSpendApproval` in developer-tasks.ts). Never asked for a task in another org. */
  resumeTask(input: { orgId: OrgId; taskId: string; spendRequestId: string; resetRunWindow: boolean; firstDispatch: boolean; resume?: "implement"; runLimitUsd?: number; spendingAdmission?: SpendingAdmissionReference; expectedPausedAgentRevision?: number }): Promise<void | "STALE">;
  prepareApprovalAdmission?(input: { orgId: OrgId; taskId: string; decisionRequestId: string; spendRequestId: string; snapshot: CapturedTaskStop; budgetBaselineUsd: number }): Promise<PreparedTaskApprovalAdmission | undefined>;
  /** A test run that reached its cap goes on as a normal task of its owner (`POST /v1/app/tasks/{id}/continue-as-task`). */
  continueAsTask?(caller: AgentCaller, taskId: string, body: unknown): Promise<unknown>;
  /** What a task's model keys have spent so far, in dollars (the proxy's figure); how a pause that was never written is worked out from the end. */
  taskSpentUsd?: (keyIds: readonly string[]) => Promise<number>;
}

export type SpendRequestDependencies = AgentRouteDependencies;

/** Who may decide a request now, read live: the role it is routed to, the people who hold it, and the words "Only <who> can decide this." ends with. */
export interface SpendApprovers {
  role: SpendApproverRole;
  ids: string[];
  who: string;
  /**
   * A `month` request routed to an agent's owner: whose total it was summed in, the owner counter's `version` it was summed at and the spend policy's
   * revision the cap was read from (R4-6). An approval by that read holds both as conditions (fix round 1, C-1 and M-9).
   */
  owner?: { developerId: string; version: number; policyRevision: number };
}

export interface DecideSpendBody {
  requestId: string;
  decision: "APPROVE" | "DENY";
  amountUsd?: number;
}

type Item = Record<string, unknown>;

const DAY_MS = 86_400_000;
const NAME_MAX = 80;
const REQUEST_SLOT = "SPEND_REQUEST_SLOT";
/** How many open requests one settlement page takes, and how many a person's list reads at most. */
const PAGE = 100;
const LIST_MAX = 200;

const iso = (ms: number): string => new Date(ms).toISOString();
const dollars = (usd: number): string => `$${String(Number(cleanUsd(usd).toFixed(2)))}`;
const logLine = (deps: Pick<SpendRequestDependencies, "log">, event: string, fields: Item): void =>
  (deps.log ?? ((name, rest) => console.log(JSON.stringify({ component: "broker", event: name, ...rest }))))(event, fields);
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");
const notFound = () => agentXError("NOT_FOUND", "spend request not found");
const ENDED_WORDS: Record<NonNullable<SpendRequestRecord["endedBecause"]>, string> = {
  figures_changed: "Spending figures changed; ask again.",
  spending_rules_changed: "Spending rules changed; ask again.",
  continued: "The task went on without this, so nobody can decide it now.",
  task_closed: "This task was closed, so nobody can decide this now.",
  target_left: "The person this change names is no longer a member of your organization, so it can't apply now.",
  owner_moved: "This agent's budget now counts for someone else than the person this change was checked for, so it can't apply. Nothing was changed; ask again.",
  approver_left: "Everyone who could decide this has left your organization, so it was closed without a decision. Ask again if it is still needed.",
};
const closed = (record: Pick<SpendRequestRecord, "status" | "endedBecause">) =>
  agentXError("APPROVAL_CLOSED", record.status !== "EXPIRED" ? "This request was already decided." : record.endedBecause === undefined ? "This request expired, so nobody can decide it now." : ENDED_WORDS[record.endedBecause]);

 
const CONTROL = /[\p{Cc}\p{Cf}]/gu;
/** A reason as it is stored: control and format characters spaced out, at most `SPEND_REQUEST_REASON_MAX` code points. */
function cleanReason(text: string): string {
  return Array.from(text.replace(CONTROL, " ").replace(/\s+/g, " ").trim()).slice(0, SPEND_REQUEST_REASON_MAX).join("");
}

async function getItem(deps: Pick<SpendRequestDependencies, "documentClient" | "tableName">, key: { pk: string; sk: string }): Promise<Item | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;
}

async function queryAll(deps: Pick<SpendRequestDependencies, "documentClient" | "tableName">, pk: string, prefix?: string, limit = Infinity): Promise<Item[]> {
  const found: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, ConsistentRead: true,
      KeyConditionExpression: prefix === undefined ? "pk = :pk" : "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: prefix === undefined ? { ":pk": pk } : { ":pk": pk, ":prefix": prefix },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    found.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start !== undefined && found.length < limit);
  return found;
}

// ---- the record

const KINDS = new Set(["run_limit", "max_per_run", "planning", "month", "owner_cap"]);
const STATUSES = new Set(["PENDING", "APPROVED", "DENIED", "EXPIRED"]);

/** A stored record as the module reads it; anything malformed is not a request (fail closed: nobody can decide it). */
function recordOf(item: Item | undefined, orgId: OrgId): SpendRequestRecord | undefined {
  if (item === undefined || item["entityType"] !== "SPEND_REQUEST" || item["orgId"] !== orgId) return undefined;
  if (!KINDS.has(String(item["kind"])) || !STATUSES.has(String(item["status"])) || typeof item["spendRequestId"] !== "string" || typeof item["amountUsd"] !== "number") return undefined;
  const { pk: _pk, sk: _sk, entityType: _type, ...rest } = item; // eslint-disable-line @typescript-eslint/no-unused-vars -- only the keys are dropped
  return { ...rest, approverIds: Array.isArray(item["approverIds"]) ? (item["approverIds"] as unknown[]).filter((id): id is string => typeof id === "string") : [] } as unknown as SpendRequestRecord;
}

/** The request `spendRequestId` of `orgId`, or undefined (another org's, a missing one and a malformed id read the same). */
export async function getSpendRequest(deps: Pick<SpendRequestDependencies, "documentClient" | "tableName">, orgId: OrgId, spendRequestId: string): Promise<SpendRequestRecord | undefined> {
  if (!SpendRequestIdSchema.safeParse(spendRequestId).success) return undefined;
  return recordOf(await getItem(deps, spendRequestKey(orgId, spendRequestId)), orgId);
}

async function readTask(deps: Pick<SpendRequestDependencies, "documentClient" | "tableName">, orgId: OrgId, taskId: string | undefined): Promise<DeveloperTaskRecord | undefined> {
  if (taskId === undefined) return undefined;
  const task = await getItem(deps, taskKey(taskId)) as DeveloperTaskRecord | undefined;
  return task?.orgId === orgId ? task : undefined;
}

async function nameOf(deps: Pick<SpendRequestDependencies, "signInStore">, developerId: string | undefined): Promise<string> {
  if (developerId === undefined) return "a teammate";
  try {
    const name = (await deps.signInStore.getDeveloper(developerId))?.displayName;
    return name === undefined ? "a teammate" : Array.from(name.replace(CONTROL, " ")).slice(0, NAME_MAX).join("").trim() || "a teammate";
  } catch {
    return "a teammate";
  }
}

// ---- a month's budget (Task 33)

/** One kind of budget an owner holds, summed for the owner cap: its base plus this month's top-ups. Plan 3 registers agents; Plan 4 adds chains (N3). */
export type OwnerTotalContributor = (deps: SpendRequestDependencies, input: { orgId: OrgId; owner: string; month: string }) => Promise<number>;

/** The agents an owner holds (member-owned, or accountable for), each at its monthly budget plus this month's top-up. */
const agentBudgets: OwnerTotalContributor = async (deps, { orgId, owner, month }) => {
  let total = 0;
  for (const agent of await deps.store.ownerAgents(orgId, owner)) {
    total += agent.monthlyBudgetUsd + await readTopUp(deps, orgId, month, { kind: "agent", agentId: agent.agentId });
  }
  return cleanUsd(total);
};

/**
 * The chains an owner holds (member-owned, or accountable for), each at its monthly budget plus this month's top-up. The owner counter holds agents and chains
 * together (one total, `OwnerBudgets`), so the effective total sums both.
 */
const chainBudgets: OwnerTotalContributor = async (deps, { orgId, owner, month }) => {
  if (deps.chains === undefined) return 0;
  let total = 0;
  for (const chain of await deps.chains.ownerChains(orgId, owner)) total += chain.monthlyBudgetUsd + await readTopUp(deps, orgId, month, { kind: "chain", chainId: chain.chainId });
  return cleanUsd(total);
};

/** Every budget an owner holds counts toward the cap through one of these, so a top-up can't get round it through any of them. */
export const OWNER_TOTAL_CONTRIBUTORS: OwnerTotalContributor[] = [agentBudgets, chainBudgets];

/**
 * What one owner's budgets total this month, top-ups included (every `OWNER_TOTAL_CONTRIBUTORS`), and the owner counter's `version` read before the sum (R4-6).
 * A change after that read moves the version, so an approval conditional on it can't apply on a stale sum. `owner` is a member already read as its survivor.
 */
export async function ownerEffectiveTotal(deps: SpendRequestDependencies, input: { orgId: OrgId; owner: string; month: string }): Promise<{ totalUsd: number; counterUsd: number; version: number }> {
  await deps.store.ensureOwnerTotal(input.orgId, input.owner);
  const counter = await getItem(deps, ownerBudgetKey(input.orgId, input.owner));
  const version = typeof counter?.["version"] === "number" ? counter["version"] : 0;
  const counterUsd = typeof counter?.["totalUsd"] === "number" ? counter["totalUsd"] : 0;
  let totalUsd = 0;
  for (const contributor of OWNER_TOTAL_CONTRIBUTORS) totalUsd += await contributor(deps, input);
  return { totalUsd: cleanUsd(totalUsd), counterUsd, version };
}

/**
 * The owner's effective total this month as Task 28's budget writes are held to it (fix round 1, I-1): the total, the base the owner counter holds, and the
 * counter's version, so the write is conditional on nothing having moved since (`OwnerCap.seen`).
 */
export async function effectiveOwnerCap(deps: SpendRequestDependencies, orgId: OrgId, owner: string): Promise<{ totalUsd: number; counterUsd: number; version: number; month: string }> {
  const month = iso(deps.now()).slice(0, 7);
  return { ...await ownerEffectiveTotal(deps, { orgId, owner, month }), month };
}

/** An agent's monthly limit for `month` before the guardrail's clamp: its base plus the month's top-up (fix round 1, I-4). */
async function unclampedAgentLimit(deps: SpendRequestDependencies, orgId: OrgId, month: string, agentId: string): Promise<number> {
  return (await agentLimitParts(deps, orgId, month, agentId)).limitUsd;
}

/** The unclamped limit and the top-up it was summed with, so a write can be held to that top-up (fix round 2, minor 2). */
async function agentLimitParts(deps: SpendRequestDependencies, orgId: OrgId, month: string, agentId: string): Promise<{ limitUsd: number; topUpUsd: number }> {
  const base = isBuiltinAgentId(agentId) ? (await deps.store.getBuiltinSettings(orgId, agentId))?.monthlyBudgetUsd : (await deps.store.get(orgId, agentId))?.monthlyBudgetUsd;
  const topUpUsd = await readTopUp(deps, orgId, month, { kind: "agent", agentId });
  return { limitUsd: cleanUsd((base ?? 0) + topUpUsd), topUpUsd };
}

/** A chain's monthly limit for `month` before the guardrail's clamp: its base plus the month's top-up, with the top-up it was summed with. */
async function chainLimitParts(deps: SpendRequestDependencies, orgId: OrgId, month: string, chainId: string): Promise<{ limitUsd: number; topUpUsd: number }> {
  const base = (await deps.chains?.get(orgId, chainId))?.monthlyBudgetUsd;
  const topUpUsd = await readTopUp(deps, orgId, month, { kind: "chain", chainId: chainId });
  return { limitUsd: cleanUsd((base ?? 0) + topUpUsd), topUpUsd };
}

/** The version of an owner's counter now (0 for a counter from before versions). */
async function ownerCounterVersion(deps: SpendRequestDependencies, orgId: OrgId, owner: string): Promise<number> {
  await deps.store.ensureOwnerTotal(orgId, owner);
  const version = (await getItem(deps, ownerBudgetKey(orgId, owner)))?.["version"];
  return typeof version === "number" ? version : 0;
}

/** The UTC month a `month` request tops up: the month it was made in. */
const monthOfRequest = (record: Pick<SpendRequestRecord, "createdAt">): string => {
  const stored = (record as { topUpMonth?: unknown }).topUpMonth;
  return typeof stored === "string" ? stored : record.createdAt.slice(0, 7);
};

/** When a `month` request made at `now` ends: after `SPEND_REQUEST_TTL_DAYS`, or when its month does if that is sooner (fix round 1, M-3). */
const monthRequestExpiry = (now: number): number => {
  const at = new Date(now);
  return Math.min(now + SPEND_REQUEST_TTL_DAYS * DAY_MS, Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
};

/** How a `month` request is routed for each kind of scope (Plan 4 adds `chain`). */
export type MonthApproverRule = (deps: SpendRequestDependencies, request: SpendRequestRecord, amountUsd: number) => Promise<SpendApprovers>;

const toAdmins: MonthApproverRule = (deps, request) => admins(deps, request.orgId);

/**
 * An agent's month goes to its owner while its new limit stays within the guardrail's `maxAgentMonthlyUsd` and the owner's effective total with the top-up stays
 * within `ownerAgentBudgetCapUsd`; else (a human decision) to the org's owners and admins. A built-in, or an agent no one is answerable for, goes to the admins.
 * The new limit is read live (fix round 1, I-4): the agent's base plus this month's top-up, before the guardrail's clamp, plus the amount.
 */
const agentMonth: MonthApproverRule = async (deps, request, amountUsd) => {
  const { orgId } = request;
  const scope = request.scope as Extract<BudgetScope, { kind: "agent" }>;
  if (isBuiltinAgentId(scope.agentId)) return admins(deps, orgId);
  const agent = await deps.store.get(orgId, scope.agentId);
  const raw = agent === undefined ? undefined : budgetOwnerOf(agent);
  if (raw === undefined) return admins(deps, orgId);
  const owner = await resolveSurvivor(deps, orgId, raw);
  const month = monthOfRequest(request);
  if (cleanUsd(await unclampedAgentLimit(deps, orgId, month, scope.agentId) + amountUsd) > (await readGuardrails(deps, orgId)).maxAgentMonthlyUsd) return admins(deps, orgId);
  const { policy, revision } = await readSpendPolicyWithRevision(deps, orgId);
  const { totalUsd, version } = await ownerEffectiveTotal(deps, { orgId, owner, month });
  if (cleanUsd(totalUsd + amountUsd) > policy.ownerAgentBudgetCapUsd) return admins(deps, orgId);
  const owners = await agentOwners(deps, orgId, scope.agentId);
  return owners.role === "org_admin" ? owners : { ...owners, owner: { developerId: owner, version, policyRevision: revision } };
};

/**
 * A chain's month goes to its owner (a member, or the owning project's maintainers) while its new limit stays within the guardrail's `maxAgentMonthlyUsd` and the
 * sum of that owner's effective agent and chain limits, with the top-up, stays within `ownerAgentBudgetCapUsd`; else to the org's owners and admins. A chain no one
 * is answerable for, or one that is gone, goes to the admins. A requester never decides their own request (`mayDecideNow`).
 */
const chainMonth: MonthApproverRule = async (deps, request, amountUsd) => {
  const { orgId } = request;
  const scope = request.scope as Extract<BudgetScope, { kind: "chain" }>;
  const chain = await deps.chains?.get(orgId, scope.chainId);
  const raw = chain === undefined ? undefined : budgetOwnerOf(chain);
  if (raw === undefined) return admins(deps, orgId);
  const owner = await resolveSurvivor(deps, orgId, raw);
  const month = monthOfRequest(request);
  if (cleanUsd((await chainLimitParts(deps, orgId, month, scope.chainId)).limitUsd + amountUsd) > (await readGuardrails(deps, orgId)).maxAgentMonthlyUsd) return admins(deps, orgId);
  const { policy, revision } = await readSpendPolicyWithRevision(deps, orgId);
  const { totalUsd, version } = await ownerEffectiveTotal(deps, { orgId, owner, month });
  if (cleanUsd(totalUsd + amountUsd) > policy.ownerAgentBudgetCapUsd) return admins(deps, orgId);
  const owners = await chainOwners(deps, orgId, scope.chainId);
  return owners.role === "org_admin" ? owners : { ...owners, owner: { developerId: owner, version, policyRevision: revision } };
};

export const MONTH_APPROVERS: Record<BudgetScope["kind"], MonthApproverRule> = {
  org: toAdmins,
  member: toAdmins,
  project: toAdmins,
  testing: toAdmins,
  agent: agentMonth,
  chain: chainMonth,
};

const BUDGET_SCOPE_KINDS = new Set(["org", "member", "project", "agent", "chain", "testing"]);
const isBudgetScope = (scope: PauseScope | undefined): scope is BudgetScope => scope !== undefined && BUDGET_SCOPE_KINDS.has(scope.kind);

/** The one-pending subject of a month's request: the month, the scope and who asked (`system` for a pause). */
const monthSubject = (month: string, scope: BudgetScope, requester: string): string => `MONTH#${month}#${scopeKey(scope)}#${requester}`;

// ---- who decides

/** The org's owners and admins now, each once, a merged-away duplicate left out (their survivor is listed on their own). */
async function orgAdmins(deps: SpendRequestDependencies, orgId: OrgId): Promise<string[]> {
  const members = await queryAll(deps, orgPk(orgId), "MEMBER#");
  const ids: string[] = [];
  for (const member of members) {
    const id = member["developerId"];
    if ((member["role"] !== "owner" && member["role"] !== "admin") || typeof id !== "string") continue;
    if (await resolveSurvivor(deps, orgId, id) === id) ids.push(id);
  }
  return ids.sort();
}

/** The maintainers of a project by a grant of their own (an org owner or admin is a maintainer of every project by their role, and is not one of these). */
async function grantMaintainers(deps: SpendRequestDependencies, orgId: OrgId, project: string): Promise<string[]> {
  return (await deps.projectMembers.list(orgId, project)).filter((member) => member.role === "maintainer" && member.source === "grant").map((member) => member.developerId).sort();
}

const ADMINS_WHO = "an organization owner or admin";
const maintainersWho = (project: string) => `a maintainer of ${project}`;

/** The org's owners and admins, as an answer. */
async function admins(deps: SpendRequestDependencies, orgId: OrgId): Promise<SpendApprovers> {
  return { role: "org_admin", ids: await orgAdmins(deps, orgId), who: ADMINS_WHO };
}

/** A project's maintainers by grant, else (a project with none) the org's owners and admins. */
async function maintainersOrAdmins(deps: SpendRequestDependencies, orgId: OrgId, project: string, role: SpendApproverRole): Promise<SpendApprovers> {
  const ids = await grantMaintainers(deps, orgId, project);
  return ids.length > 0 ? { role, ids, who: maintainersWho(project) } : admins(deps, orgId);
}

/** Who owns an agent, as approvers: the member owner, the owning project's maintainers (whichever project it is shared to), org admins for a built-in. */
async function agentOwners(deps: SpendRequestDependencies, orgId: OrgId, agentId: string): Promise<SpendApprovers> {
  if (isBuiltinAgentId(agentId)) return admins(deps, orgId);
  const agent = await deps.store.get(orgId, agentId);
  if (agent === undefined) return admins(deps, orgId);
  if (agent.owner.kind === "member") return { role: "agent_owner", ids: [agent.owner.developerId], who: `${await nameOf(deps, agent.owner.developerId)}, the agent's owner` };
  return maintainersOrAdmins(deps, orgId, agent.owner.project, "agent_owner");
}

/** Who owns a chain, as approvers: the member owner, the owning project's maintainers; the org's admins for a chain that is gone or has no one to answer. */
async function chainOwners(deps: SpendRequestDependencies, orgId: OrgId, chainId: string): Promise<SpendApprovers> {
  const chain = await deps.chains?.get(orgId, chainId);
  if (chain === undefined) return admins(deps, orgId);
  if (chain.owner.kind === "member") return { role: "chain_owner", ids: [chain.owner.developerId], who: `${await nameOf(deps, chain.owner.developerId)}, the chain's owner` };
  return maintainersOrAdmins(deps, orgId, chain.owner.project, "chain_owner");
}

/** The payer of a task, as approvers: the member who pays, a paying project's maintainers, a paying agent's owner, a paying chain's owner. */
async function payerOf(deps: SpendRequestDependencies, orgId: OrgId, task: DeveloperTaskRecord): Promise<SpendApprovers> {
  const payer = task.payer ?? { kind: "member" as const, developerId: task.developerId };
  if (payer.kind === "member") return { role: "payer", ids: [payer.developerId], who: await nameOf(deps, payer.developerId) };
  if (payer.kind === "project") {
    const ids = await grantMaintainers(deps, orgId, payer.project);
    return ids.length > 0 ? { role: "payer", ids, who: maintainersWho(payer.project) } : admins(deps, orgId);
  }
  if (payer.kind === "chain") return chainOwners(deps, orgId, payer.chainId);
  const owners = await agentOwners(deps, orgId, payer.agentId);
  return owners.role === "org_admin" ? owners : { ...owners, role: "payer" };
}

/**
 * Whether the new limit `limitUsd` of a chain step's task is a run-level raise: it takes the run past the limit the run had left when the step started
 * (`remainingAtStartUsd`, Task 5's `settleStepSpend`). Below that, the money was inside the chain's own limit already. The run's side is read through
 * `chainRunBudgets`; a run it can't find is a run-level raise (fail closed).
 */
async function chainRaise(deps: SpendRequestDependencies, task: DeveloperTaskRecord, limitUsd: number): Promise<{ runLevel: boolean; chainId: string | undefined }> {
  const payerChain = task.payer?.kind === "chain" ? task.payer.chainId : undefined;
  if (task.chain === undefined) return { runLevel: false, chainId: payerChain };
  const limits = await deps.chainRunBudgets?.stepLimits(task.orgId as OrgId, task.chain).catch(() => undefined);
  if (limits === undefined) return { runLevel: true, chainId: payerChain };
  return { runLevel: limitUsd > limits.remainingAtStartUsd + 0.000001, chainId: limits.chainId };
}

/** The limit a request would set for the amount asked or approved. A planning request's limit is its new window (the reset window starts from nothing). */
function newLimitFor(record: Pick<SpendRequestRecord, "kind" | "amountUsd" | "newLimitUsd">, amountUsd: number): number {
  if (record.kind === "planning") return cleanUsd(amountUsd);
  return cleanUsd((record.newLimitUsd ?? record.amountUsd) - record.amountUsd + amountUsd);
}

/**
 * Who may decide `request` for `amountUsd` (by default what it asks), read now (R68):
 *   - `run_limit`, `planning`: a new limit within the lead threshold goes to the payer (the member; a paying project's maintainers; a paying agent's owner); within
 *     the admin threshold to the project's maintainers by grant, else the org's owners and admins; above it to the org's owners and admins.
 *   - `max_per_run`: the agent's owner (the member; the owning project's maintainers; org admins for a built-in) while the raised stop stays within the
 *     company's `maxPerRunCeilingUsd`, else the org's owners and admins. Once escalated, the org's owners and admins too.
 *   - `owner_cap`: the org's owners and admins.
 *   - `month`: by `MONTH_APPROVERS` (an agent's to its owner within the guardrail and the cap, every other scope to the org's owners and admins).
 * A list that names nobody who is still a member (a payer who left) falls to the org's owners and admins. The person a request is for (`requestedFor`: a run's
 * starter, a month request's asker, or the starter of the task whose pause asked) is left out where they may not decide it (`withoutStarter`).
 */
export async function spendApprovers(deps: SpendRequestDependencies, request: SpendRequestRecord, amountUsd: number = request.amountUsd): Promise<SpendApprovers> {
  const { orgId } = request;
  let found: SpendApprovers;
  if (request.kind === "run_limit" || request.kind === "planning") {
    const task = await readTask(deps, orgId, request.taskId);
    if (task === undefined) return admins(deps, orgId);
    const policy = await readSpendPolicy(deps, orgId);
    const limit = newLimitFor(request, amountUsd);
    const project = task.place?.project ?? task.project;
    // A chain step's raise past what its run had left is a run-level raise (`chainRaise`): whatever the payer and the amount, the chain's owner decides it (a chain
    // run never goes past its limit without them), and the admins above the admin threshold, or when the chain or the run can't be read (fail closed).
    const raise = await chainRaise(deps, task, limit);
    if (raise.runLevel) {
      found = limit <= policy.adminApprovalThresholdUsd && raise.chainId !== undefined ? await chainOwners(deps, orgId, raise.chainId) : await admins(deps, orgId);
    } else if (task.payer?.kind === "agent") {
      // Owner decision 3 (option E): an agent that pays has its owner decide a run limit of any size (its max per run and the company's ceiling bound what it can
      // spend); when the owner has left, its managers (the owning project's maintainers) and then the org's admins.
      found = await agentOwners(deps, orgId, task.payer.agentId);
    } else if (limit <= policy.leadApprovalThresholdUsd) found = await payerOf(deps, orgId, task);
    else if (limit <= policy.adminApprovalThresholdUsd) found = await maintainersOrAdmins(deps, orgId, project, "project_maintainer");
    else found = await admins(deps, orgId);
  } else if (request.kind === "max_per_run") {
    const task = await readTask(deps, orgId, request.taskId);
    // A project's process layer is Rovara Code with the project's rules on top, and its tasks are held to the org's Rovara Code max per run (`runLimits`): the request to raise it
    // goes where the built-in's does (the org's owners and admins), never to the layer's owner, the project's maintainers.
    const agentId = task?.agent?.process === true ? ROVARA_CODE_AGENT_ID : task?.agent?.agentId;
    if (task === undefined || agentId === undefined) return admins(deps, orgId);
    const ceiling = (await readGuardrails(deps, orgId)).maxPerRunCeilingUsd;
    found = newLimitFor(request, amountUsd) <= ceiling ? await agentOwners(deps, orgId, agentId) : await admins(deps, orgId);
    if (request.escalatedAt !== undefined && found.role !== "org_admin") {
      found = { role: found.role, ids: [...new Set([...found.ids, ...await orgAdmins(deps, orgId)])].sort(), who: `${found.who}, or ${ADMINS_WHO}` };
    }
  } else if (request.kind === "month" && isBudgetScope(request.scope)) {
    found = await MONTH_APPROVERS[request.scope.kind](deps, request, amountUsd);
  } else {
    found = await admins(deps, orgId);
  }
  const members = await Promise.all(found.ids.map(async (id) => (await orgRoleOf(deps, orgId, id)) !== undefined));
  return withoutStarter(deps, request, members.some(Boolean) ? found : await admins(deps, orgId), amountUsd);
}

/** The person whose run a task's request is for (its starter), as the survivor of any merge. */
async function starterOf(deps: SpendRequestDependencies, request: SpendRequestRecord): Promise<string | undefined> {
  return request.requestedFor === undefined ? undefined : resolveSurvivor(deps, request.orgId, request.requestedFor.developerId);
}

/**
 * Whether a run's starter may decide their own run's request (fix round 1, I-4): a run limit or planning limit when they are the payer member, or the org's
 * only owner or admin (merge of Tasks 32 and 34: else nobody could decide it); a max per run never, even as the agent's owner, unless they are the org's only owner or admin (as an owner's cap is ruled). A month's request (Task 33 fix round 1,
 * I-3, M-11) the same as a max per run: its asker, or the starter of the task whose pause asked, never decides it unless they are the only owner or admin.
 * A chain step's raise past its run's limit is never the payer's to decide; and a chain's owner who starts the run is no exception (Plan 4 Task 5, review M-5).
 */
async function starterMayDecide(deps: SpendRequestDependencies, request: SpendRequestRecord, starter: string, amountUsd: number = request.amountUsd): Promise<boolean> {
  // The org's only owner or admin, whatever the kind: nobody else could decide it, and the request would wait until it expired.
  const ids = await orgAdmins(deps, request.orgId);
  if (ids.length === 1 && ids[0] === starter) return true;
  if (request.kind === "max_per_run" || request.kind === "month") return false;
  // A raise that takes a chain run past its own limit is the chain's owner's to decide, not the payer's: the payer exception does not cover it.
  const task = await readTask(deps, request.orgId, request.taskId);
  if (task?.chain !== undefined && (await chainRaise(deps, task, newLimitFor(request, amountUsd))).runLevel) return false;
  const payer = await taskPayerId(deps, request);
  return payer !== undefined && await resolveSurvivor(deps, request.orgId, payer) === starter;
}

/** Approvers without the run's starter where they may not decide: someone else of the same list, else the org's other owners and admins. */
async function withoutStarter(deps: SpendRequestDependencies, request: SpendRequestRecord, found: SpendApprovers, amountUsd: number): Promise<SpendApprovers> {
  const starter = await starterOf(deps, request);
  if (starter === undefined || await starterMayDecide(deps, request, starter, amountUsd)) return found;
  const survivors = await Promise.all(found.ids.map((id) => resolveSurvivor(deps, request.orgId, id)));
  const rest = found.ids.filter((_id, index) => survivors[index] !== starter);
  if (rest.length === found.ids.length) return found;
  if (rest.length > 0) return { ...found, ids: rest };
  const fallback = found.role === "org_admin" ? found : await admins(deps, request.orgId);
  const others = fallback.ids.filter((id) => id !== starter);
  return others.length > 0 ? { ...fallback, ids: others } : fallback;
}

/** The words a pause message uses for who was asked. */
const askedWords = (role: SpendApproverRole): string => (role === "payer" ? "the payer" : role === "project_maintainer" ? "a project maintainer" : role === "agent_owner" ? "the agent's owner" : role === "chain_owner" ? "the chain's owner" : "an admin");

/** The payer of a task request, read now (who "the payer" is). */
async function taskPayerId(deps: SpendRequestDependencies, record: SpendRequestRecord): Promise<string | undefined> {
  const task = await readTask(deps, record.orgId, record.taskId);
  const payer = task === undefined ? undefined : task.payer ?? { kind: "member" as const, developerId: task.developerId };
  return payer?.kind === "member" ? payer.developerId : undefined;
}

/**
 * Whether `caller` may decide `record` for `amountUsd` now: they are one of its approvers (a merged duplicate counting as its survivor), and not the person who
 * asked, unless they are the task's payer or, for an `owner_cap` request, the org's only owner or admin. Nor the run's starter (`requestedFor`), unless
 * `starterMayDecide`. Answers the approvers it read too: a decision is made on that one read (fix round 1, C-1).
 */
async function mayDecideNow(deps: SpendRequestDependencies, caller: Pick<AgentCaller, "orgId" | "developerId">, record: SpendRequestRecord, amountUsd?: number): Promise<{ allowed: boolean; who: string; approvers: SpendApprovers }> {
  const approvers = await spendApprovers(deps, record, amountUsd);
  const answer = (allowed: boolean) => ({ allowed, who: approvers.who, approvers });
  const me = await resolveSurvivor(deps, caller.orgId, caller.developerId);
  if (await orgRoleOf(deps, caller.orgId, me) === undefined) return answer(false);
  const survivors = await Promise.all(approvers.ids.map((id) => resolveSurvivor(deps, caller.orgId, id)));
  if (!survivors.includes(me)) return answer(false);
  if (record.requestedBy.kind === "member" && await resolveSurvivor(deps, caller.orgId, record.requestedBy.developerId) === me) {
    if (record.kind === "owner_cap") return answer(survivors.every((id) => id === me));
    if (record.kind === "month") return answer(await starterMayDecide(deps, record, me));
    const payer = await taskPayerId(deps, record);
    // Task 32's rule on every path: the one who asked decides only as the payer, or as the org's only owner or admin (nobody else could decide it).
    const admins = await orgAdmins(deps, caller.orgId);
    return answer((payer !== undefined && await resolveSurvivor(deps, caller.orgId, payer) === me) || (admins.length === 1 && admins[0] === me));
  }
  if (await starterOf(deps, record) === me && !await starterMayDecide(deps, record, me, amountUsd)) return answer(false);
  return answer(true);
}

/**
 * Whether `caller` may decide the request now: it exists in their org, is still PENDING and not past its time, and they are one of its approvers
 * (read live). For a session's view, which shows the budget link only to the people who can use it. A request that isn't there, or another org's, is false.
 */
export async function mayDecideSpendRequest(deps: SpendRequestDependencies, caller: Pick<AgentCaller, "orgId" | "developerId">, spendRequestId: string): Promise<boolean> {
  const record = await getSpendRequest(deps, caller.orgId, spendRequestId);
  if (record === undefined || record.status !== "PENDING" || Date.parse(record.expiresAt) <= deps.now()) return false;
  return (await mayDecideNow(deps, caller, record)).allowed;
}

// ---- making a request

export interface CreateSpendRequestInput {
  orgId: OrgId;
  kind: SpendRequestKind;
  scope?: PauseScope;
  taskId?: string;
  agentId?: string;
  /** The chain an `owner_cap` request is about (Plan 4). */
  chainId?: string;
  newOwner?: { developerId: string };
  /** An `owner_cap` request: the person whose total it was summed against (`SpendRequestRecord.forOwner`). */
  forOwner?: string;
  amountUsd: number;
  newLimitUsd?: number;
  /** What the person deciding is told; a function when the words name who was asked (known once the approvers are read). */
  reason: string | ((approvers: SpendApprovers, amountUsd: number) => string);
  requestedBy: SpendRequestRecord["requestedBy"];
  /** A task's request: the run's starter (`task.startedBy`, else its owner). */
  requestedFor?: { developerId: string };
  resume?: SpendRequestRecord["resume"];
  change?: OwnerCapChange;
  ownerFinancialTerms?: SpendRequestRecord["ownerFinancialTerms"];
  approvalSource?: ApprovalSource;
  /** The subject the one-pending rule is kept for: the task, by default; an `owner_cap` request's agent or person. */
  subject?: string;
  /** Written in the same transaction as the request (a task event, the asking request's own item). `request` is R18's mark, with what to answer a repeat. */
  extraItems?: (record: SpendRequestRecord, approvers: SpendApprovers) => Promise<TransactItem[]> | TransactItem[];
  request?: RequestMark;
  /** What the request's R18 item remembers; given the record once it is known. */
  requestResult?: (record: SpendRequestRecord, approvers: SpendApprovers) => unknown;
}

const subjectOf = (input: Pick<CreateSpendRequestInput, "subject" | "taskId" | "agentId">): string =>
  input.subject ?? (input.taskId !== undefined ? `TASK#${input.taskId}` : `AGENT#${input.agentId ?? ""}`);

/** The request already open for a subject and kind, if its slot names one that is still PENDING. */
async function openRequestFor(deps: SpendRequestDependencies, orgId: OrgId, subject: string, kind: SpendRequestKind): Promise<SpendRequestRecord | undefined> {
  const slot = await getItem(deps, spendRequestSlotKey(orgId, subject, kind));
  const id = slot?.["spendRequestId"];
  if (typeof id !== "string") return undefined;
  const record = await getSpendRequest(deps, orgId, id);
  return record?.status === "PENDING" ? record : undefined;
}

const audited = (deps: Parameters<typeof tryAuditEvents>[0], build: () => AuditEventInput[]): Promise<AuditEventInput[]> => tryAuditEvents(deps, build);
/** The due item the settlement run reads, at `dueAt`. */
const dueItem = (record: SpendRequestRecord, dueAt: string): Item =>
  ({ ...openSpendRequestDueKey(dueAt, record.orgId, record.spendRequestId), entityType: "SPEND_REQUEST_DUE", orgId: record.orgId, spendRequestId: record.spendRequestId, dueAt });
const dueKeyOf = (record: SpendRequestRecord) => openSpendRequestDueKey(record.dueAt ?? record.createdAt, record.orgId, record.spendRequestId);
const facts = (record: SpendRequestRecord) => ({
  spendRequestId: record.spendRequestId, kind: record.kind, scopeKind: record.scope?.kind ?? (record.kind === "owner_cap" ? "agent" : "none"), amountCents: centsOf(record.amountUsd),
  ...(record.newLimitUsd === undefined ? {} : { newLimitCents: centsOf(record.newLimitUsd) }),
});

/**
 * Makes a request, once per subject and kind: while one is PENDING, a second asks for nothing new and answers the first (`created: false`). The record, the org's
 * open index, the due index, the slot, the audit of its creation and `extraItems` are one transaction. The approvers stored on it are who it was routed to now.
 */
export async function createSpendRequest(deps: SpendRequestDependencies, input: CreateSpendRequestInput): Promise<{ record: SpendRequestRecord; created: boolean; approvers: SpendApprovers }> {
  const subject = subjectOf(input);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await openRequestFor(deps, input.orgId, subject, input.kind);
    if (existing !== undefined) return { record: existing, created: false, approvers: await spendApprovers(deps, existing) };
    const now = deps.now();
    const createdAt = iso(now);
    const draft: SpendRequestRecord = {
      orgId: input.orgId, spendRequestId: newPrefixedId("spr"), kind: input.kind,
      ...(input.scope === undefined ? {} : { scope: input.scope }), ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.chainId === undefined ? {} : { chainId: input.chainId }),
      ...(input.newOwner === undefined ? {} : { newOwner: input.newOwner }), ...(input.forOwner === undefined ? {} : { forOwner: input.forOwner }),
      amountUsd: cleanUsd(input.amountUsd), ...(input.newLimitUsd === undefined ? {} : { newLimitUsd: cleanUsd(input.newLimitUsd) }),
      reason: "", requestedBy: input.requestedBy, ...(input.requestedFor === undefined ? {} : { requestedFor: input.requestedFor }),
      approverRole: "org_admin", approverIds: [], status: "PENDING",
      ...(input.resume === undefined ? {} : { resume: input.resume }), ...(input.change === undefined ? {} : { change: input.change }),
      ...(input.approvalSource === undefined ? {} : { approvalSource: input.approvalSource }),
      ...(input.ownerFinancialTerms === undefined ? {} : { ownerFinancialTerms: input.ownerFinancialTerms }),
      createdAt, expiresAt: iso(input.kind === "month" ? monthRequestExpiry(now) : now + SPEND_REQUEST_TTL_DAYS * DAY_MS),
    };
    if (draft.taskId !== undefined && (draft.kind === "run_limit" || draft.kind === "max_per_run" || draft.kind === "planning")) {
      const source = await readTask(deps, draft.orgId, draft.taskId), owner = source === undefined ? undefined : tryEffectiveTaskOwner(source);
      if (source !== undefined && owner !== undefined) {
        const developerId = draft.requestedBy.kind === "member" ? draft.requestedBy.developerId : draft.requestedFor?.developerId ?? owner.developerId;
        const role = await orgRoleOf(deps, draft.orgId, developerId);
        if (role === undefined && source.spendingStop !== undefined) throw budgetActorRefused();
        if (role !== undefined) {
          const actor = { orgId: draft.orgId, developerId, orgRole: role }, agentId = source.agent?.agentId ?? ROVARA_CODE_AGENT_ID;
          const snapshot = await captureTaskStopAdmission({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, requireScopeAccess: async () => {
            await requireNativeProjectWorkRole(deps, source, actor);
            await requireAgentAccess(deps, actor, agentId, source.agent?.version === "draft" ? "edit" : "use");
          } }, { orgId: draft.orgId, developerId, role, project: source.project, agentId, ...savedTaskStopBounds(source.spendingStop),
            pathLimitMicrousd: source.spendingStop?.calculationInput.pathLimitMicrousd ?? usdToWholeMicrodollars(source.budgetUsd ?? PER_TASK_BUDGET_USD) ?? null });
          if (snapshot.kind === "captured") draft.approvalTerms = makeTaskApprovalTerms(source, snapshot, draft);
        }
      }
    }
    const approvers = await spendApprovers(deps, draft);
    const reason = cleanReason(typeof input.reason === "string" ? input.reason : input.reason(approvers, draft.amountUsd));
    // The settlement run looks at it again when an owner's answer is due (an unanswered max per run escalates), else at its expiry (M-5).
    const dueAt = draft.kind === "max_per_run" && approvers.role !== "org_admin" ? iso(now + OWNER_ANSWER_HOURS * 3_600_000) : draft.expiresAt;
    const record: SpendRequestRecord = { ...draft, reason, approverRole: approvers.role, approverIds: approvers.ids, dueAt };
    const events = await audited(deps, () => [auditSpendRequestCreated({
      orgId: record.orgId, actor: record.requestedBy.kind === "member" ? auditActorOf(record.requestedBy.developerId) : auditActorOf("system"),
      occurredAt: createdAt, occurrence: record.spendRequestId, ...facts(record),
    })]);
    const extra = input.extraItems === undefined ? [] : await input.extraItems(record, approvers);
    const items: TransactItem[] = [
      // The slot's subject is kept on the record, so the request's end frees exactly the slot it took.
      {
        Put: {
          TableName: deps.tableName,
          Item: {
            ...spendRequestKey(record.orgId, record.spendRequestId), entityType: "SPEND_REQUEST", ...record, slotSubject: subject,
            // A month's request tops up the month it was made in; one routed to an agent's owner keeps the owner counter's version it was summed at (R4-6).
            ...(record.kind === "month" ? { topUpMonth: createdAt.slice(0, 7) } : {}),
            ...(approvers.owner === undefined ? {} : { ownerVersion: approvers.owner.version }),
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
      { Put: { TableName: deps.tableName, Item: { ...spendRequestSlotKey(record.orgId, subject, record.kind), entityType: REQUEST_SLOT, orgId: record.orgId, spendRequestId: record.spendRequestId, createdAt }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: deps.tableName, Item: { ...openSpendRequestsKey(record.orgId, createdAt, record.spendRequestId), entityType: "SPEND_REQUEST_OPEN", orgId: record.orgId, spendRequestId: record.spendRequestId, approverIds: record.approverIds } } },
      { Put: { TableName: deps.tableName, Item: dueItem(record, dueAt) } },
      ...extra,
      ...events.flatMap((event) => auditPending(deps, event)),
      ...(input.request === undefined ? [] : [requestMarkItem(deps, input.request, input.requestResult?.(record, approvers) ?? { spendRequestId: record.spendRequestId })]),
    ];
    const requestMarkIndex = input.request === undefined ? undefined : items.length - 1;
    const taskSourceIndex = record.approvalTerms === undefined ? undefined : pinTaskApprovalSource(deps.tableName, items, TaskApprovalTermsSchema.parse(record.approvalTerms));
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      const failed = failedIndexes(error);
      // Another request took the slot first: answer that one.
      if (failed?.has(1) === true) continue;
      if (taskSourceIndex !== undefined && failed?.has(taskSourceIndex)) throw staleApproval();
      if (requestMarkIndex !== undefined && failed?.has(requestMarkIndex)) throw agentXError("IDEMPOTENCY_CONFLICT", "This request ID is already being used for another change.");
      throw error;
    }
    await flushAuditEvents(deps, events);
    return { record, created: true, approvers };
  }
  throw agentXError("AGENT_REVISION_CONFLICT", "Someone else asked for this at the same time. Try again.");
}

/**
 * Task 34's seam `agents.requestRunLimit`, wired to this module: a plan approved at a run limit above the approver's tier makes a `run_limit` request that
 * `resume: "implement"` (no pause, since the workflow is blocked on the limit, not paused by the budget). It is made once per task (`createSpendRequest`'s slot), so
 * a repeat of the plan's approval answers the request that is open; the task's starter is the person it is for (`requestedFor`), as for any run's request.
 * Answers `undefined` for a task that is not the org's (nothing asked), and throws what `createSpendRequest` throws, which refuses the plan's approval.
 */
export function runLimitRequester(deps: SpendRequestDependencies): RequestRunLimit {
  return async (request) => {
    const task = await readTask(deps, request.orgId, request.taskId);
    if (task === undefined) return undefined;
    const { record } = await createRunLimitRequest(deps, task, request);
    return { spendRequestId: record.spendRequestId };
  };
}

/** The `run_limit` request that resumes a blocked plan's coding, for the task's starter, in its own slot (so an open request that resumes nothing cannot answer for it). */
function createRunLimitRequest(
  deps: SpendRequestDependencies, task: DeveloperTaskRecord, request: Pick<RunLimitRequest, "orgId" | "amountUsd" | "newLimitUsd" | "reason" | "requestedBy">, mark?: RequestMark,
  extraItems?: TransactItem[],
) {
  return createSpendRequest(deps, {
    orgId: request.orgId, kind: "run_limit", scope: { kind: "task", taskId: task.taskId }, taskId: task.taskId, amountUsd: request.amountUsd, newLimitUsd: request.newLimitUsd,
    reason: request.reason, requestedBy: request.requestedBy, requestedFor: { developerId: isTaskTakenOver(task) ? effectiveTaskOwner(task).developerId : task.startedBy?.developerId ?? effectiveTaskOwner(task).developerId }, resume: "implement",
    // Its own slot: an open `run_limit` request that resumes nothing (the follow-up after a max-per-run raise) must not answer for the plan, since approving it would not start coding.
    subject: planRunLimitSubject(task.taskId),
    ...(extraItems === undefined ? {} : { extraItems: () => extraItems }),
    ...(mark === undefined ? {} : { request: mark, requestResult: (record: SpendRequestRecord) => ({ spendRequestId: record.spendRequestId, created: true }) }),
  });
}

const AskRunLimitSchema = z.object({ requestId: z.string().uuid() }).strict();
const planBlockedOnRunLimit = (task: DeveloperTaskRecord): boolean =>
  task.closedAt === undefined && task.workflow?.stage === "IMPLEMENT" && task.workflow.state === "BLOCKED" && isRunLimitBlockReason(task.workflow.blockReason);

/**
 * `POST /v1/app/tasks/{id}/run-limit-request` [the task's owner]: `{ requestId }`. A plan blocked on its run limit has one way on, the approval of a `run_limit`
 * request; once the last one was denied or ran out, the owner asks again here, for the same plan and limit, routed as the first was. It only asks (R66): coding
 * starts when a person approves the new request on its page. While a request is open it answers that one (`created: false`); one whose time has run out but that
 * the sweep has not ended yet is ended as EXPIRED first. R18: a repeat of the request ID answers what it first did. Anyone but the task's owner gets the
 * answer a task they can't see gets.
 */
async function askRunLimitAgain(deps: SpendRequestDependencies, caller: AgentCaller, taskId: string, value: unknown): Promise<StatusReply> {
  const parsed = AskRunLimitSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "is not valid"}`);
  }
  const task = await readTask(deps, caller.orgId, taskId);
  const me = await resolveSurvivor(deps, caller.orgId, caller.developerId);
  if (task === undefined || tryEffectiveTaskOwner(task) === undefined || await resolveSurvivor(deps, caller.orgId, effectiveTaskOwner(task).developerId) !== me) throw agentXError("TASK_NOT_FOUND", `task ${taskId} doesn't exist`);
  const mark: RequestMark = {
    orgId: caller.orgId, developerId: caller.developerId, requestId: parsed.data.requestId,
    fingerprint: createHash("sha256").update(JSON.stringify(["ask-run-limit", taskId])).digest("hex"),
  };
  const earlier = await readRequest(deps, caller.orgId, caller.developerId, parsed.data.requestId);
  if (earlier !== undefined) {
    if (earlier.fingerprint !== mark.fingerprint) throw agentXError("CONFIG_INVALID", "requestId: this request ID was already used for a different request");
    return new StatusReply((earlier.result as { created?: boolean }).created === true ? 201 : 200, earlier.result as object);
  }
  if (!planBlockedOnRunLimit(task)) {
    // Final fix wave (money I-3): a run paused on its run limit, planning limit or max per run, or held at its start, asks again the same way.
    const kind = task.closedAt === undefined && task.budgetPause !== undefined ? REQUEST_KIND_OF_PAUSE[task.budgetPause.scope.kind] : undefined;
    if (kind === undefined) throw agentXError("CONFIG_INVALID", "this task is not waiting for a run limit");
    return askPauseAgain(deps, task, kind, mark);
  }
  // Approved, and the start after the approval has not been made yet (it is retried): there is nothing left to ask for.
  if (await getItem(deps, heldPlanStartKey(caller.orgId, taskId)) !== undefined) {
    throw agentXError("CONFIG_INVALID", "the run limit was approved and coding is starting; there is nothing to ask for");
  }
  let open = await openRequestFor(deps, caller.orgId, planRunLimitSubject(taskId), "run_limit");
  if (open !== undefined && Date.parse(open.expiresAt) <= deps.now()) {
    await expireOne(deps, open);
    open = await openRequestFor(deps, caller.orgId, planRunLimitSubject(taskId), "run_limit");
  }
  // A new request, not the answer to one that is open: at most one in ten minutes, so approvers are not asked over and over.
  if (open === undefined) {
    const next = await nextAskAt(deps, caller.orgId, taskId);
    if (next !== undefined) throw agentXError("CONFIG_INVALID", `You asked for this run limit a few minutes ago. You can ask again after ${iso(next)}.`);
  }
  const { runLimitUsd, needs } = await askedRunLimit(deps, task);
  const askedAt = deps.now();
  const made = await createRunLimitRequest(deps, task, {
    orgId: caller.orgId, newLimitUsd: runLimitUsd, amountUsd: Math.max(0, cleanUsd(runLimitUsd - (task.budgetUsd ?? 0))), requestedBy: { kind: "member", developerId: me },
    reason: `Asked again: this plan's run limit is $${String(runLimitUsd)}, which needs ${needs === "maintainer" ? "a project maintainer's" : "an admin's"} approval.`,
  }, mark, [{ Put: { TableName: deps.tableName, Item: {
    ...runLimitAskedKey(caller.orgId, taskId), entityType: "RUN_LIMIT_ASKED", orgId: caller.orgId, taskId, at: iso(askedAt), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(askedAt / 1000) + 86_400,
  } } }]);
  const answer = { spendRequestId: made.record.spendRequestId, created: made.created };
  // An ask that found a request open (the open one, or one made by another ask in the meantime) wrote no mark with it: the answer is remembered here.
  if (!made.created) {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [requestMarkItem(deps, mark, answer)] })).catch((error: unknown) => {
      if (failedIndexes(error)?.has(0) !== true) throw error;
    });
  }
  return new StatusReply(made.created ? 201 : 200, answer);
}

/**
 * The owner's ask again for a task-level pause (final fix wave, money I-3), on the route a plan's run limit has: an agent-step run paused on its run limit or its
 * max per run, a coding run paused on a limit, or a run held at its start, whose request was denied, ran out or was never made. The request is the one the pause
 * asks for (`askPausedTask`), routed as the first was. While one is open it answers that one; a new one is made at most once in ten minutes, and R18 remembers it.
 */
async function askPauseAgain(deps: SpendRequestDependencies, task: DeveloperTaskRecord, kind: SpendRequestKind, mark: RequestMark): Promise<StatusReply> {
  const orgId = task.orgId as OrgId;
  const subject = `TASK#${task.taskId}`;
  let open = await openRequestFor(deps, orgId, subject, kind);
  if (open !== undefined && Date.parse(open.expiresAt) <= deps.now()) {
    await expireOne(deps, open);
    open = await openRequestFor(deps, orgId, subject, kind);
  }
  if (open === undefined) {
    const next = await nextAskAt(deps, orgId, task.taskId);
    if (next !== undefined) throw agentXError("CONFIG_INVALID", `You asked for this run limit a few minutes ago. You can ask again after ${iso(next)}.`);
  }
  const askedAt = deps.now();
  const made = await askPausedTask(deps, task.taskId, {}, { mark, items: [{ Put: { TableName: deps.tableName, Item: {
    ...runLimitAskedKey(orgId, task.taskId), entityType: "RUN_LIMIT_ASKED", orgId, taskId: task.taskId, at: iso(askedAt), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(askedAt / 1000) + 86_400,
  } } }] });
  if (made === undefined) throw agentXError("CONFIG_INVALID", "this task is not waiting for a run limit");
  const answer = { spendRequestId: made.record.spendRequestId, created: made.created };
  if (!made.created) {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [requestMarkItem(deps, mark, answer)] })).catch((error: unknown) => {
      if (failedIndexes(error)?.has(0) !== true) throw error;
    });
  }
  return new StatusReply(made.created ? 201 : 200, answer);
}

/** When the owner may next make a new ask for a plan's run limit, if that is still ahead; undefined when they may now. */
export async function nextAskAt(deps: Pick<SpendRequestDependencies, "documentClient" | "tableName" | "now">, orgId: OrgId, taskId: string): Promise<number | undefined> {
  const last = await getItem(deps, runLimitAskedKey(orgId, taskId));
  const at = typeof last?.["at"] === "string" ? Date.parse(last["at"]) : Number.NaN;
  return Number.isFinite(at) && at + RUN_LIMIT_ASK_COOLDOWN_MS > deps.now() ? at + RUN_LIMIT_ASK_COOLDOWN_MS : undefined;
}

/** A task event, written once per key: a pause message, an approval's note. */
function taskEventItem(deps: Pick<SpendRequestDependencies, "tableName">, task: Pick<DeveloperTaskRecord, "taskId" | "orgId">, at: string, tag: string, text: string): TransactItem {
  return {
    Put: {
      TableName: deps.tableName,
      Item: { pk: `DEVTASK#${task.taskId}`, sk: `EVENT#${at}#${tag}`, entityType: "TASK_EVENT", orgId: task.orgId, kind: "status", text: cleanReason(text), at },
      ConditionExpression: "attribute_not_exists(pk)",
    },
  };
}

// ---- a paused task's request

/** The test cap's message (no request: the way on is `continue-as-task`). */
const testCapMessage = (capUsd: number, project: string) =>
  `This test reached its ${dollars(capUsd)} cap. Continue it as a normal task? It will then count against your monthly limit and ${project}'s budget.`;

/** What a run limit is now: the task's own, or the default per-task budget. */
const runLimitOf = (task: DeveloperTaskRecord): number => task.budgetUsd ?? PER_TASK_BUDGET_USD;

/**
 * The scope a pause that was never written stands for (Task 31's Minor 2: the pause write failed, or the refusal wrote none), worked out from the task's own
 * figures at its end: a test run past its cap, else a run whose window reached where it stops (the agent's max per run when that is the lower, the planning limit
 * while planning, else the run limit). A budget scope (a month that ran out) is not derived: Task 33's top-ups raise those.
 */
async function derivedPause(deps: SpendRequestDependencies, task: DeveloperTaskRecord, refusal: { workflowMode?: string }): Promise<PauseScope | undefined> {
  const spentOf = deps.spendRequests?.taskSpentUsd;
  if (spentOf === undefined) return undefined;
  const spent = await spentOf(task.modelKeyIds ?? []);
  if (task.origin === "test_run" && spent >= (await readSpendPolicy(deps, task.orgId as OrgId)).perTestCapUsd - 0.000001) return { kind: "test", taskId: task.taskId };
  const window = cleanUsd(Math.max(0, spent - (task.budgetBaselineUsd ?? 0)));
  const runLimit = runLimitOf(task);
  const stop = Math.min(runLimit, task.maxPerRunUsd ?? Infinity);
  if (window < stop - 0.000001) return undefined;
  const kind = stop < runLimit ? "max_per_run" : refusal.workflowMode === "PLAN" || refusal.workflowMode === "UNDERSTAND" ? "planning" : "task";
  return { kind, taskId: task.taskId };
}

/**
 * The task's budget ran out (its operation ended `budget_exhausted`): the request its pause asks for. A task-level pause asks the person who may raise that limit;
 * a test's cap asks for nothing (the task's owner may continue it as a normal task); a month's budget asks for nothing here. A pause the task has not got is
 * derived from the end (`derivedPause`) and written first. Answers the request, or undefined when nothing was asked.
 */
export async function requestForPausedTask(deps: SpendRequestDependencies, taskId: string, refusal: { workflowMode?: string; operationId?: string } = {}): Promise<SpendRequestRecord | undefined> {
  return (await askPausedTask(deps, taskId, refusal))?.record;
}

/** `requestForPausedTask`, answering whether the request was made now; `ask` is an owner's ask again (final fix wave, money I-3): its R18 mark and the items written with it. */
async function askPausedTask(
  deps: SpendRequestDependencies, taskId: string, refusal: { workflowMode?: string; operationId?: string } = {}, ask?: { mark: RequestMark; items: TransactItem[] },
): Promise<{ record: SpendRequestRecord; created: boolean } | undefined> {
  let task = await getItem(deps, taskKey(taskId)) as DeveloperTaskRecord | undefined;
  if (task?.orgId === undefined) return undefined;
  const orgId = task.orgId;
  if (task.budgetPause === undefined) {
    const scope = await derivedPause(deps, task, refusal);
    if (scope === undefined) return undefined;
    const pause = { scope, at: iso(deps.now()) };
    try {
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName, Key: taskKey(taskId), UpdateExpression: refusal.operationId === undefined ? "SET #pause = :pause" : "SET #pause = :pause, budgetStopOf = :operation",
        ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(#pause)", ExpressionAttributeNames: { "#pause": "budgetPause" },
        ExpressionAttributeValues: { ":pause": pause, ...(refusal.operationId === undefined ? {} : { ":operation": refusal.operationId }) },
      }));
    } catch (error) {
      if (errorName(error) !== "ConditionalCheckFailedException") throw error;
    }
    task = await getItem(deps, taskKey(taskId)) as DeveloperTaskRecord | undefined;
    if (task?.budgetPause === undefined || task.orgId !== orgId) return undefined;
  }
  const pause = task.budgetPause;
  const scope = pause.scope;
  if (isBudgetScope(scope)) {
    const monthly = await requestForMonth(deps, task, { scope, at: pause.at });
    return monthly === undefined ? undefined : { record: monthly, created: true };
  }
  if (!("taskId" in scope) || scope.taskId !== taskId) return undefined;
  if (scope.kind === "test") {
    const capUsd = (await readSpendPolicy(deps, orgId)).perTestCapUsd;
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [taskEventItem(deps, task, pause.at, "pause", testCapMessage(capUsd, task.project))] }));
    } catch (error) {
      if (failedIndexes(error) === undefined) throw error;
    }
    return undefined;
  }
  const limit = runLimitOf(task);
  const requestedFor = { developerId: isTaskTakenOver(task) ? effectiveTaskOwner(task).developerId : task.startedBy?.developerId ?? effectiveTaskOwner(task).developerId };
  const input: Omit<CreateSpendRequestInput, "reason"> & { message: (approvers: SpendApprovers, amountUsd: number) => string } = scope.kind === "max_per_run"
    ? (() => {
      const max = task.maxPerRunUsd ?? limit;
      const amountUsd = suggestedTopUpUsd(max);
      const agent = task.agent?.name ?? "The agent";
      return {
        orgId, kind: "max_per_run" as const, scope, taskId, amountUsd, newLimitUsd: cleanUsd(max + amountUsd), requestedBy: { kind: "system" as const }, resume: "continue" as const,
        message: (approvers: SpendApprovers, amount: number) => `This run reached ${agent}'s max per run (${dollars(max)}). I asked ${approvers.role === "org_admin" ? "an admin" : "the agent's owner"} to approve ${dollars(amount)} more for this run.`,
      };
    })()
    : scope.kind === "planning"
      ? {
        orgId, kind: "planning" as const, scope, taskId, amountUsd: suggestedTopUpUsd(limit), newLimitUsd: suggestedTopUpUsd(limit), requestedBy: { kind: "system" as const }, resume: "plan" as const,
        message: (_approvers: SpendApprovers, amount: number) => `Planning reached its ${dollars(limit)} limit. Here's what it found so far. Approve ${dollars(amount)} more to finish the plan.`,
      }
      : {
        orgId, kind: "run_limit" as const, scope, taskId, amountUsd: suggestedTopUpUsd(limit), newLimitUsd: cleanUsd(limit + suggestedTopUpUsd(limit)), requestedBy: { kind: "system" as const },
        resume: "continue" as const,
        message: (approvers: SpendApprovers, amount: number) => `This task needs about ${dollars(amount)} more to finish. I asked ${askedWords(approvers.role)} to approve it.`,
      };
  if (scope.kind !== "task" && scope.kind !== "max_per_run" && scope.kind !== "planning") return undefined;
  const { message, ...asked } = input;
  const create = { ...asked, requestedFor };
  // The pause message names who was asked; the task event carrying it commits with the request.
  const made = await createSpendRequest(deps, {
    ...create, reason: message,
    extraItems: (record) => [taskEventItem(deps, task, record.createdAt, `spr${record.spendRequestId}`, record.reason), ...(ask?.items ?? [])],
    ...(ask === undefined ? {} : { request: ask.mark, requestResult: (record: SpendRequestRecord) => ({ spendRequestId: record.spendRequestId, created: true }) }),
  });
  return { record: made.record, created: made.created };
}

/** What a task stopped by a month's budget says, naming who was asked. */
function monthMessage(scope: BudgetScope, task: DeveloperTaskRecord, approvers: SpendApprovers, amountUsd: number): string {
  const who = approvers.role === "org_admin" ? "an admin" : askedWords(approvers.role);
  const ask = `I asked ${who} to add ${dollars(amountUsd)} for this month.`;
  switch (scope.kind) {
    case "member": return `Your monthly AI budget is used up. ${ask}`;
    case "testing": return `Your testing allowance for this month is used up. ${ask}`;
    case "project": return `The ${scope.project} project's monthly AI budget is used up. ${ask}`;
    case "agent": return `${task.agent?.agentId === scope.agentId ? task.agent.name : "This agent"}'s monthly AI budget is used up. ${ask}`;
    case "org": return `Your company's monthly AI budget is used up. ${ask}`;
    case "chain": return `This chain's monthly AI budget is used up. ${ask}`;
  }
}

/**
 * A task stopped by a month's budget: it is listed under that scope (`pausedTasksKey`), so the top-up resumes it with every other task the same budget stopped,
 * and the scope's month asks once (one PENDING per month, scope and requester; a pause asks as the system, for the task's starter, who may not approve it).
 * A scope with no limit lists nothing and asks for nothing (R47). The listing is written before the open request is looked for, so a pause that finds a
 * request approved at the same moment is still resumed by it.
 */
async function requestForMonth(deps: SpendRequestDependencies, task: DeveloperTaskRecord, pause: { scope: BudgetScope; at: string }): Promise<SpendRequestRecord | undefined> {
  const orgId = task.orgId as OrgId;
  const { scope } = pause;
  const month = iso(deps.now()).slice(0, 7);
  const limit = (await effectiveLimits(deps, { orgId, month, scopes: [scope] })).get(scopeKey(scope));
  if (limit === undefined) return undefined;
  await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
    { Put: { TableName: deps.tableName, Item: { ...pausedTasksKey(orgId, pauseKey(scope), task.taskId), entityType: "PAUSED_TASK", orgId, taskId: task.taskId, scope, pausedAt: pause.at } } },
    // The global list of month-paused tasks, by the month they were paused in: the settlement run reads it when a new month starts (final fix wave, money I-3).
    { Put: { TableName: deps.tableName, Item: { ...monthPausedKey(pause.at, orgId, task.taskId), entityType: "MONTH_PAUSED_TASK", orgId, taskId: task.taskId, scope, pausedAt: pause.at } } },
  ] }));
  const amountUsd = suggestedMonthTopUpUsd(limit);
  const made = await createSpendRequest(deps, {
    orgId, kind: "month", scope, subject: monthSubject(month, scope, "system"), amountUsd, newLimitUsd: cleanUsd(limit + amountUsd),
    requestedBy: { kind: "system" }, requestedFor: { developerId: isTaskTakenOver(task) ? effectiveTaskOwner(task).developerId : task.startedBy?.developerId ?? effectiveTaskOwner(task).developerId },
    reason: (approvers, amount) => monthMessage(scope, task, approvers, amount),
    extraItems: (record) => [taskEventItem(deps, task, record.createdAt, `spr${record.spendRequestId}`, record.reason)],
  });
  return made.record;
}

/** The settlement run's global list of tasks a month's budget stopped, oldest month first (`pausedAt` is an instant, its month is the sort key's start). */
const MONTH_PAUSED_PK = "MONTH_PAUSED_TASKS";
const monthPausedKey = (pausedAt: string, orgId: string, taskId: string) => ({ pk: MONTH_PAUSED_PK, sk: `${pausedAt.slice(0, 7)}#${orgId}#${taskId}` });
const MONTH_RESUMES_BUDGET_MS = 750;
/** What a scope must have left in the new month for its tasks to go on: the least a task's run needs (a task's own minimum at the proxy). */
const MONTH_ROOM_USD = 0.5;

/**
 * The top-up's own approval: every task listed under the scope that is still paused on it, by the pause it was listed with, goes on, keeping its cap window.
 * In one transaction per task the item is deleted and the pause removed (conditional on that pause and the task being open), and a due resume is written
 * (fix round 1, I-5): it is deleted once the task went on, and until then the settlement run tries again (`retryHeldStarts`). A task that closed, or now
 * waits on another limit or another pause, only loses its item.
 */
async function resumeMonthTasks(deps: SpendRequestDependencies, record: SpendRequestRecord, scope: BudgetScope): Promise<void> {
  const pk = pausedTasksKey(record.orgId, pauseKey(scope), "-").pk;
  for (const item of await queryAll(deps, pk)) await resumeMonthTask(deps, record.orgId, scope, item, record.spendRequestId);
}

/** One listed task of a month's scope goes on (see `resumeMonthTasks`). True when it was resumed here. */
async function resumeMonthTask(deps: SpendRequestDependencies, orgId: OrgId, scope: BudgetScope, item: Item, spendRequestId: string): Promise<boolean> {
  const pk = pausedTasksKey(orgId, pauseKey(scope), "-").pk;
  const now = deps.now();
  const taskId = String(item["sk"]);
  const listedAt = typeof item["pausedAt"] === "string" ? item["pausedAt"] : undefined;
  const task = await readTask(deps, orgId, taskId);
  const pause = task?.closedAt === undefined ? task?.budgetPause : undefined;
  const waits = pause !== undefined && pauseKey(pause.scope) === pauseKey(scope) && (listedAt === undefined || pause.at === listedAt);
  const due = heldStartKey(iso(now), orgId, taskId);
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      // A pause made again after this read lists the task again: that listing is kept (M-2).
      {
        Delete: {
          TableName: deps.tableName, Key: { pk, sk: taskId },
          ...(listedAt === undefined ? {} : { ConditionExpression: "attribute_not_exists(pk) OR pausedAt = :listed", ExpressionAttributeValues: { ":listed": listedAt } }),
        },
      },
      ...(listedAt === undefined ? [] : [{ Delete: { TableName: deps.tableName, Key: monthPausedKey(listedAt, orgId, taskId) } }]),
      ...(waits ? [
        {
          Update: {
            TableName: deps.tableName, Key: taskKey(taskId), UpdateExpression: "SET updatedAt = :now REMOVE budgetPause",
            ConditionExpression: "budgetPause.#at = :at AND attribute_not_exists(closedAt)", ExpressionAttributeNames: { "#at": "at" },
            ExpressionAttributeValues: { ":now": iso(now), ":at": pause.at },
          },
        },
        {
          Put: {
            TableName: deps.tableName,
            Item: { ...due, entityType: "SPEND_MONTH_RESUME", resume: "month", orgId, taskId, spendRequestId, expiresAt: iso(now + SPEND_REQUEST_TTL_DAYS * DAY_MS) },
          },
        },
      ] : []),
    ] }));
  } catch (error) {
    if (failedIndexes(error) === undefined) throw error;
    return false;
  }
  if (!waits) return false;
  try {
    await deps.spendRequests?.resumeTask({ orgId, taskId, spendRequestId, resetRunWindow: false, firstDispatch: false });
    if (deps.spendRequests !== undefined) await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Delete: { TableName: deps.tableName, Key: due } }] }));
    return true;
  } catch (error) {
    logLine(deps, "spend_request.resume_failed", { spendRequestId, taskId, error: errorName(error) });
    return false;
  }
}

/**
 * A new month (final fix wave, money I-3): the tasks a month's budget stopped in an earlier month, listed under `MONTH_PAUSED_TASKS`, go on once their scope has room
 * in this month, whatever became of the request that asked for a top-up (it ended with the month). No person is needed, so an event's or a schedule's run is resumed
 * too. A task that closed, or went on or paused on something else, only loses its listing. The scope's room is its limit less what the ledger counts this month
 * (none counted yet, at the start of a month); a proxy that still refuses stops the task again, and it is listed again for this month, so this runs once per task
 * per month. Stops at `deadline`.
 */
async function resumeRolledMonths(deps: SpendRequestDependencies, deadline: number): Promise<{ resumed: number; complete: boolean }> {
  const current = iso(deps.now()).slice(0, 7);
  let resumed = 0;
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND sk < :current", ExpressionAttributeValues: { ":pk": MONTH_PAUSED_PK, ":current": current }, ConsistentRead: true, Limit: PAGE,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      if (deps.now() >= deadline) return { resumed, complete: false };
      const orgId = item["orgId"] as OrgId | undefined;
      const taskId = item["taskId"];
      const scope = item["scope"] as BudgetScope | undefined;
      const pausedAt = item["pausedAt"];
      if (typeof orgId !== "string" || typeof taskId !== "string" || scope === undefined || !isBudgetScope(scope) || typeof pausedAt !== "string") continue;
      try {
        const task = await readTask(deps, orgId, taskId);
        const pause = task?.closedAt === undefined ? task?.budgetPause : undefined;
        if (pause === undefined || pauseKey(pause.scope) !== pauseKey(scope) || pause.at !== pausedAt) {
          // Closed, gone on or stopped by something else: nothing to resume, and the listing goes.
          await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
            { Delete: { TableName: deps.tableName, Key: { pk: String(item["pk"]), sk: String(item["sk"]) } } },
            { Delete: { TableName: deps.tableName, Key: pausedTasksKey(orgId, pauseKey(scope), taskId), ConditionExpression: "attribute_not_exists(pk) OR pausedAt = :listed", ExpressionAttributeValues: { ":listed": pausedAt } } },
          ] })).catch(() => undefined);
          continue;
        }
        const limit = (await effectiveLimits(deps, { orgId, month: current, scopes: [scope] })).get(scopeKey(scope));
        const counter = limit === undefined ? undefined : await getItem(deps, spendCounterKey(orgId, current, scopeKey(scope)));
        const committed = typeof counter?.["committedUsd"] === "number" ? counter["committedUsd"] : 0;
        if (limit !== undefined && limit - committed < MONTH_ROOM_USD) continue;
        const listed = await getItem(deps, pausedTasksKey(orgId, pauseKey(scope), taskId));
        if (await resumeMonthTask(deps, orgId, scope, listed ?? { sk: taskId, pausedAt }, `rollover-${current}`)) resumed += 1;
      } catch (error) {
        logLine(deps, "spend_request.month_rollover_failed", { taskId, error: errorName(error) });
      }
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return { resumed, complete: true };
}

/**
 * An ended month's request leaves its tasks paused and listed (fix round 1, I-2): another open request for the same scope resumes them when it is approved.
 * Only the items whose task closed, or is no longer paused on the scope, are pruned.
 */
async function prunePausedTasks(deps: Pick<SpendRequestDependencies, "documentClient" | "tableName">, record: SpendRequestRecord): Promise<void> {
  if (record.kind !== "month" || !isBudgetScope(record.scope)) return;
  const scope = record.scope;
  const pk = pausedTasksKey(record.orgId, pauseKey(scope), "-").pk;
  for (const item of await queryAll(deps, pk)) {
    const taskId = String(item["sk"]);
    const task = await readTask(deps, record.orgId, taskId);
    if (task !== undefined && task.closedAt === undefined && task.budgetPause !== undefined && pauseKey(task.budgetPause.scope) === pauseKey(scope)) continue;
    await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk, sk: taskId } }));
    if (typeof item["pausedAt"] === "string") await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: monthPausedKey(item["pausedAt"], record.orgId, taskId) }));
  }
}

// ---- an owner's cap

/** `budgets` says what the total holds: a change of an agent's budget says "agent" (as it always has), a chain's, whose total holds both kinds, "agent and chain". */
const ownerCapSentence = (name: string, wouldBeUsd: number, capUsd: number, budgets: "agent" | "agent and chain" = "agent") =>
  `${name}'s ${budgets} budgets would total ${dollars(wouldBeUsd)} a month, over the ${dollars(capUsd)} limit for one person.`;
/** What the person whose change waits is told. */
export const ownerCapMessage = (reason: string) => `${reason} I asked an org admin to approve it.`;

/**
 * The `owner_cap` request of a change held by the cap (Task 28's seam, PF27): made once per agent (or, for a chain's budget change, once per chain), and the
 * change waits for an org admin. Nothing changes while it is PENDING; `request` is the asking route's R18 mark, which remembers the 202 answer. Answers the
 * request and the words the route answers with.
 */
export async function requestOwnerCap(deps: SpendRequestDependencies, input: {
  orgId: OrgId; agentId?: string; chainId?: string; requestedBy: string; owner: string; wouldBeUsd: number; capUsd: number; newLimitUsd?: number; newOwner?: string; ownerFinancialTerms?: SpendRequestRecord["ownerFinancialTerms"]; change: OwnerCapChange; request?: RequestMark; before: BudgetSubject;
}): Promise<{ record: SpendRequestRecord; message: string }> {
  const chainId = input.chainId;
  if ((input.agentId === undefined) === (chainId === undefined)) throw new Error("an owner_cap request is about an agent or a chain");
  const key = chainId !== undefined ? chainKey(input.orgId, chainId, "META") : isBuiltinAgentId(input.agentId as never) ? builtinSettingsKey(input.orgId, input.agentId as never) : agentKey(input.orgId, input.agentId as never, "META");
  const original = await getItem(deps, key);
  for (const field of ["status", "owner", "accountable", "monthlyBudgetUsd"] as const) {
    if (canonicalJson(original?.[field]) !== canonicalJson(input.before[field])) throw staleApproval();
  }
  // Existing rows retain the complete original source, including per-run and
  // revision fields. A missing built-in row has only virtual defaults, which
  // are not persisted authority and remain represented as absence.
  if (original !== undefined && canonicalJson(sourceFields(original)) !== canonicalJson(sourceFields(input.before as unknown as Record<string, unknown>))) throw staleApproval();
  const approvalSource: ApprovalSource = { version: 1, key, exists: original !== undefined, fields: sourceFields(original) };
  const reason = ownerCapSentence(await nameOf(deps, input.owner), input.wouldBeUsd, input.capUsd, chainId === undefined ? "agent" : "agent and chain");
  const made = await createSpendRequest(deps, {
    orgId: input.orgId, kind: "owner_cap",
    ...(chainId === undefined ? { scope: { kind: "agent" as const, agentId: input.agentId as never }, agentId: input.agentId as string } : { scope: { kind: "chain" as const, chainId: chainId }, chainId, subject: `CHAIN#${chainId}` }),
    ...(input.newOwner === undefined ? {} : { newOwner: { developerId: input.newOwner } }), forOwner: input.owner,
    amountUsd: cleanUsd(input.wouldBeUsd - input.capUsd), ...(input.newLimitUsd === undefined ? {} : { newLimitUsd: input.newLimitUsd }),
    reason, requestedBy: { kind: "member", developerId: input.requestedBy }, change: input.change, approvalSource, ownerFinancialTerms: input.ownerFinancialTerms,
    extraItems: () => [{ ConditionCheck: { TableName: deps.tableName, Key: key, ...sourceCondition(approvalSource) } }, ...(input.ownerFinancialTerms === undefined ? [] : ownerFinancialChecks(deps.tableName, input.orgId, input.ownerFinancialTerms, input))],
    ...(input.request === undefined ? {} : { request: input.request }),
    requestResult: (record) => ({ status: "NEEDS_ADMIN_APPROVAL", spendRequestId: record.spendRequestId, message: ownerCapMessage(record.reason) }),
  });
  const message = ownerCapMessage(made.record.reason);
  if (!made.created) {
    // One change waits per agent (fix round 1, I-2): another change is refused rather than answered with the first; the same change is the caller's too.
    if (canonicalJson(made.record.change) !== canonicalJson(input.change)) {
      throw agentXError(chainId === undefined ? "AGENT_REVISION_CONFLICT" : "CHAIN_REVISION_CONFLICT", `A change to this ${chainId === undefined ? "agent" : "chain"}'s budget is already waiting for an admin (${made.record.spendRequestId}). Wait for it, or ask an admin to decline it.`);
    }
    if (input.request !== undefined) {
      try {
        await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [requestMarkItem(deps, input.request, { status: "NEEDS_ADMIN_APPROVAL", spendRequestId: made.record.spendRequestId, message })] }));
      } catch (error) {
        if (failedIndexes(error) !== undefined) throw agentXError("IDEMPOTENCY_CONFLICT", "This request ID is already being used for another change.");
        throw error;
      }
    }
  }
  return { record: made.record, message };
}

/** JSON with every object's keys in order, so two equal changes read the same. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, part: unknown) => (part !== null && typeof part === "object" && !Array.isArray(part)
    ? Object.fromEntries(Object.entries(part as Item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : part));
}

/**
 * Rovara's own move left `owner` over the cap (Task 11's seam): the move already applied and counted, so an `owner_cap` request asks an org admin to confirm it.
 * Once per person while one is open; nothing when the total is within the cap.
 */
export async function confirmOwnerMove(deps: SpendRequestDependencies, orgId: OrgId, owner: string, cause: "member_merged" | "member_removed" | "project_role_changed", totals: { totalUsd: number; capUsd: number; policyRevision?: number; counterVersion?: number }): Promise<SpendRequestRecord | undefined> {
  if (totals.totalUsd <= totals.capUsd) return undefined;
  if (totals.policyRevision === undefined || totals.counterVersion === undefined) throw staleApproval();
  const ownerFinancialTerms: NonNullable<SpendRequestRecord["ownerFinancialTerms"]> = { version: 1, basis: "base", owner, month: iso(deps.now()).slice(0, 7), totalUsd: totals.totalUsd, counterUsd: totals.totalUsd, counterVersion: totals.counterVersion, capUsd: totals.capUsd, policyRevision: totals.policyRevision, carriedUsd: 0, wouldBeUsd: totals.totalUsd };
  const made = await createSpendRequest(deps, {
    orgId, kind: "owner_cap", subject: `OWNER#${owner}`, forOwner: owner, ownerFinancialTerms, extraItems: () => ownerFinancialChecks(deps.tableName, orgId, ownerFinancialTerms), amountUsd: cleanUsd(totals.totalUsd - totals.capUsd), newLimitUsd: totals.totalUsd,
    reason: ownerCapSentence(await nameOf(deps, owner), totals.totalUsd, totals.capUsd), requestedBy: { kind: "system" }, change: { op: "confirm_move", owner, cause },
  });
  return made.record;
}

// ---- deciding

const DecideBodySchema = z.object({
  requestId: z.string().uuid(),
  decision: z.enum(["APPROVE", "DENY"]),
  amountUsd: z.number().finite().positive().max(1_000_000).optional(),
}).strict();

const fingerprintOf = (spendRequestId: string, body: DecideSpendBody) =>
  createHash("sha256").update(JSON.stringify(["spend-decide", spendRequestId, body.decision, body.amountUsd ?? null])).digest("hex");

/**
 * A request as an answer shows it: no org, no keys; the page where it is decided. Shown to `viewer`, a member who is not an org owner or admin, an org-scope
 * request leaves out its new limit, which is the org's limit plus the amount (fix round 1, M-8).
 */
export function spendRequestView(deps: Pick<SpendRequestDependencies, "confirmOrigin" | "now">, record: SpendRequestRecord, viewer?: Pick<AgentCaller, "orgRole">): Record<string, unknown> {
  const { orgId: _orgId, change: _change, slotSubject: _slot, ownerVersion: _version, topUpMonth: _month, approvalSource: _approvalSource, approvalTerms: _approvalTerms, ownerFinancialTerms: _financialTerms, ...shown } = record as SpendRequestRecord & { slotSubject?: string; ownerVersion?: number; topUpMonth?: string }; // eslint-disable-line @typescript-eslint/no-unused-vars -- the org is the caller's; the stored change, slot, version and month are the store's
  // A request whose time ran out reads EXPIRED before the sweep has ended it: nobody can decide it any more.
  const expired = record.status === "PENDING" && Date.parse(record.expiresAt) <= deps.now();
  if (record.scope?.kind === "org" && viewer !== undefined && !isOrgAdminRole(viewer)) delete shown.newLimitUsd;
  return { ...shown, ...(expired ? { status: "EXPIRED" } : {}), confirmUrl: `${deps.confirmOrigin}/v1/app/approve/${record.spendRequestId}` };
}

const isOrgAdminRole = (caller: Pick<AgentCaller, "orgRole">): boolean => caller.orgRole === "owner" || caller.orgRole === "admin";

/** The end of a request in one write: its record (conditional on PENDING), its index items and its slot. */
function endItems(deps: Pick<SpendRequestDependencies, "tableName">, record: SpendRequestRecord, set: Item): TransactItem[] {
  const names: Record<string, string> = { "#status": "status" };
  const values: Record<string, unknown> = { ":pending": "PENDING" };
  const sets = Object.entries(set).map(([name, value], index) => {
    names[`#f${String(index)}`] = name;
    values[`:f${String(index)}`] = value;
    return `#f${String(index)} = :f${String(index)}`;
  });
  return [
    { Update: { TableName: deps.tableName, Key: spendRequestKey(record.orgId, record.spendRequestId), UpdateExpression: `SET ${sets.join(", ")}`, ConditionExpression: "#status = :pending", ExpressionAttributeNames: names, ExpressionAttributeValues: values } },
    { Delete: { TableName: deps.tableName, Key: openSpendRequestsKey(record.orgId, record.createdAt, record.spendRequestId) } },
    { Delete: { TableName: deps.tableName, Key: dueKeyOf(record) } },
    { Delete: { TableName: deps.tableName, Key: spendRequestSlotKey(record.orgId, subjectOfRecord(record), record.kind), ConditionExpression: "attribute_not_exists(pk) OR spendRequestId = :id", ExpressionAttributeValues: { ":id": record.spendRequestId } } },
  ];
}

const subjectOfRecord = (record: SpendRequestRecord): string => {
  const stored = (record as { slotSubject?: unknown }).slotSubject;
  return typeof stored === "string" ? stored : legacySubjectOf(record);
};
const legacySubjectOf = (record: SpendRequestRecord): string =>
  record.change?.op === "confirm_move" ? `OWNER#${record.change.owner}` : subjectOf({ ...(record.taskId === undefined ? {} : { taskId: record.taskId }), ...(record.agentId === undefined ? {} : { agentId: record.agentId }) });

/**
 * What an approval of a task's request changes on the task, conditional on the figures read; and how the task goes on. The pause the request was made for is
 * a condition too (fix round 1, I-3): while the task is still paused on it, the approval removes it and the task goes on (`resume`); once it is gone (the
 * owner went on) or another limit paused the task, the approval only raises the limit. A `resume: "implement"` request is asked at plan approval, with no pause.
 */
async function taskChange(deps: SpendRequestDependencies, record: SpendRequestRecord, task: DeveloperTaskRecord, approvedUsd: number, approvalStop?: CapturedTaskStop): Promise<{ items: TransactItem[]; resume: boolean; resetRunWindow: boolean; firstDispatch: boolean; budgetBaselineUsd: number; raisedPastRunLimit?: number }> {
  const names: Record<string, string> = { "#pause": "budgetPause", "#scope": "scope", "#kind": "kind" };
  const values: Record<string, unknown> = { ":org": task.orgId };
  const sets: string[] = ["updatedAt = :now"];
  values[":now"] = iso(deps.now());
  const conditions = ["attribute_exists(pk)", "orgId = :org", "attribute_not_exists(closedAt)"];
  const removes: string[] = [];
  const expected = record.kind === "max_per_run" ? "max_per_run" : record.kind === "planning" ? "planning" : "task";
  const forThis = task.budgetPause?.scope.kind === expected;
  const firstDispatch = forThis && task.budgetPause?.firstDispatch !== undefined;
  values[":pauseKind"] = expected;
  if (!forThis) conditions.push("(attribute_not_exists(#pause) OR #pause.#scope.#kind <> :pauseKind)");
  else conditions.push("#pause.#scope.#kind = :pauseKind");
  if (firstDispatch) {
    values[":heldOperation"] = task.budgetPause?.firstDispatch?.operationId;
    conditions.push("#pause.firstDispatch.operationId = :heldOperation");
  }
  const same = (attribute: string, value: unknown) => {
    names[`#${attribute}`] = attribute;
    if (value === undefined) conditions.push(`attribute_not_exists(#${attribute})`);
    else {
      values[`:was_${attribute}`] = value;
      conditions.push(`#${attribute} = :was_${attribute}`);
    }
  };
  if (firstDispatch && approvalStop !== undefined) same("budgetPause", task.budgetPause);
  let resetRunWindow = false;
  let budgetBaselineUsd = task.budgetBaselineUsd === undefined ? 0 : task.budgetBaselineUsd;
  let raisedPastRunLimit: number | undefined;
  // A plan's run limit request (`resume: "implement"`) applies only while the plan is still blocked on that limit, and only to the workflow as it was read:
  // once the plan moved on (another decision accepted a limit, coding runs), approving it rewrites nothing.
  const forPlan = record.kind === "run_limit" && record.resume === "implement";
  const planBlocked = task.workflow !== undefined && task.workflow.stage === "IMPLEMENT" && task.workflow.state === "BLOCKED" && isRunLimitBlockReason(task.workflow.blockReason);
  if (forPlan && planBlocked) {
    names["#workflow"] = "workflow";
    names["#wrevision"] = "revision";
    values[":wrevision"] = task.workflow!.revision;
    conditions.push("#workflow.#wrevision = :wrevision");
  }
  if (forPlan && !planBlocked) {
    // Nothing to raise: the request ends approved and the task is left as it is.
  } else if (record.kind === "run_limit" || record.kind === "planning") {
    same("budgetUsd", task.budgetUsd);
    names["#budgetUsd"] = "budgetUsd";
    values[":limit"] = approvalStop === undefined ? newLimitFor(record, approvedUsd) : approvalStop.effectiveStopMicrousd / 1_000_000;
    if (approvalStop !== undefined && usdToWholeMicrodollars(values[":limit"]) !== approvalStop.effectiveStopMicrousd) throw agentXError("TASK_STOP_CONFIG_INVALID", "The approved stop cannot be represented exactly.");
    sets.push("#budgetUsd = :limit");
    resetRunWindow = record.kind === "planning" || record.resume === "implement";
    if (resetRunWindow) {
      const spentOf = deps.spendRequests?.taskSpentUsd;
      // A window can only be reset at what the keys have spent: a proxy that can't say refuses the approval (retryable), nothing is written.
      if (spentOf === undefined) throw agentXError("MODEL_PROXY_UNAVAILABLE", "the model proxy can't say what this task has spent; try again in a minute");
      budgetBaselineUsd = cleanUsd(await spentOf(task.modelKeyIds ?? []));
      values[":baseline"] = budgetBaselineUsd;
      sets.push("budgetBaselineUsd = :baseline");
    }
    // A run held at its start is dispatched by the resume, which takes the pause in the same write as the dispatch.
    if (forThis && !firstDispatch) removes.push("#pause");
  } else if (record.kind === "max_per_run") {
    same("maxPerRunUsd", task.maxPerRunUsd);
    const stop = newLimitFor(record, approvedUsd);
    const acceptedRunMicros = approvalStop === undefined ? usdToWholeMicrodollars(runLimitOf(task)) : taskRunLimitMicrousd(task);
    if (acceptedRunMicros === undefined) throw agentXError("TASK_STOP_CONFIG_INVALID", "The accepted run limit could not be read.");
    const acceptedRunLimit = acceptedRunMicros / 1_000_000;
    if (approvalStop !== undefined) {
      const cap = approvalStop.effectiveStopMicrousd / 1_000_000;
      if (usdToWholeMicrodollars(cap) !== approvalStop.effectiveStopMicrousd) throw agentXError("TASK_STOP_CONFIG_INVALID", "The approved stop cannot be represented exactly.");
      same("budgetUsd", task.budgetUsd); sets.push("#budgetUsd = :perRunWindow"); values[":perRunWindow"] = cap;
    }
    names["#maxPerRunUsd"] = "maxPerRunUsd";
    values[":stop"] = stop;
    sets.push("#maxPerRunUsd = :stop");
    if (forThis) {
      if (approvalStop !== undefined && stop > acceptedRunLimit) { sets.push("#pause = :followRunPause"); values[":followRunPause"] = { scope: { kind: "task", taskId: task.taskId }, at: iso(deps.now()) }; }
      else removes.push("#pause");
    }
    if (stop > acceptedRunLimit) raisedPastRunLimit = acceptedRunLimit;
  }
  if (approvalStop !== undefined && !(forPlan && !planBlocked)) {
    values[":spendingStop"] = approvalStop; sets.push("spendingStop = :spendingStop");
    for (const field of ["project", "agent", "payer", "origin", "developerId", "ownerKey", "startedBy", "place", "spendingStop", "spendingAdmission", "budgetBaselineUsd"] as const) same(field, task[field]);
  }
  const update = {
    Update: {
      TableName: deps.tableName, Key: taskKey(task.taskId),
      UpdateExpression: `SET ${sets.join(", ")}${removes.length === 0 ? "" : ` REMOVE ${removes.join(", ")}`}`,
      ConditionExpression: conditions.join(" AND "),
      ExpressionAttributeNames: names, ExpressionAttributeValues: values,
    },
  };
  return { items: [update], budgetBaselineUsd, resume: !(approvalStop !== undefined && raisedPastRunLimit !== undefined) && (forThis || (forPlan && planBlocked) || (!forPlan && record.resume === "implement")), resetRunWindow, firstDispatch, ...(raisedPastRunLimit === undefined ? {} : { raisedPastRunLimit }) };
}

/** The run limit request that follows a max-per-run raise past the run limit: who it goes to, worked out before the approval writes its event. */
function followUpRunLimit(task: DeveloperTaskRecord, limitUsd: number): Omit<CreateSpendRequestInput, "reason"> {
  const amountUsd = suggestedTopUpUsd(limitUsd);
  return {
    orgId: task.orgId as OrgId, kind: "run_limit", scope: { kind: "task", taskId: task.taskId }, taskId: task.taskId, amountUsd, newLimitUsd: cleanUsd(limitUsd + amountUsd),
    requestedBy: { kind: "system" }, requestedFor: { developerId: isTaskTakenOver(task) ? effectiveTaskOwner(task).developerId : task.startedBy?.developerId ?? effectiveTaskOwner(task).developerId }, resume: "continue",
  };
}

/**
 * The stored change of an `owner_cap` request as it may apply now (fix round 1, I-1, M-4): the people it names read as their survivors and checked again as
 * the routes check them (`requireOwnerAllowed`, `requireAccountable`), and a budget checked again against the guardrails and trial limits. A person it names
 * who is no longer a member ends the request (`target_left`) and refuses with APPROVAL_CLOSED; any other refusal leaves it open.
 */
async function recheckedChange(deps: SpendRequestDependencies, decider: AgentCaller, record: SpendRequestRecord): Promise<OwnerCapChange | undefined> {
  const change = record.change;
  if (change === undefined || change.op === "confirm_move" || change.op === "unarchive") return change;
  const forChain = record.chainId !== undefined;
  if (change.op === "set_budget") {
    if (forChain) await requireChainBudgetAllowed(deps, record.orgId, change.budget.monthlyUsd);
    else await requireAgentBudgetAllowed(deps, record.orgId, change.budget);
    return change;
  }
  const member = async (developerId: string): Promise<string> => {
    const survivor = await resolveSurvivor(deps, record.orgId, developerId);
    if (await orgRoleOf(deps, record.orgId, survivor) !== undefined) return survivor;
    await expireOne(deps, record, "target_left");
    throw closed({ status: "EXPIRED", endedBecause: "target_left" });
  };
  if (!forChain && record.agentId !== undefined && isBuiltinAgentId(record.agentId) && change.op === "set_accountable") {
    const developerId = await member(change.accountable.developerId);
    const role = await orgRoleOf(deps, record.orgId, developerId);
    if (role !== "owner" && role !== "admin") throw agentXError("CONFIG_INVALID", "accountable: pick an org owner or admin for a built-in agent");
    return { op: "set_accountable", accountable: { developerId } };
  }
  // The agent or chain the change is about, and the rules for making someone its owner or accountable maintainer, which are the same for both.
  const agent = forChain ? await deps.chains?.get(record.orgId, record.chainId as string) : await deps.store.get(record.orgId, record.agentId as never);
  const accountableOf = (project: string, developerId: string) => (forChain ? requireChainAccountable(deps, record.orgId, project, developerId) : requireAccountable(deps, record.orgId, project, developerId));
  if (change.op === "set_accountable") {
    const developerId = await member(change.accountable.developerId);
    return { op: "set_accountable", accountable: agent?.owner.kind === "project" ? await accountableOf(agent.owner.project, developerId) : { developerId } };
  }
  const named = change.owner.kind === "member" ? { kind: "member" as const, developerId: await member(change.owner.developerId) } : change.owner;
  const accountableId = change.accountable === undefined ? undefined : await member(change.accountable.developerId);
  const owner = await (forChain ? requireChainOwnerAllowed(deps, decider, named, agent?.owner) : requireOwnerAllowed(deps, decider, named, agent?.owner));
  const accountable = accountableId === undefined ? undefined : owner.kind === "project" ? await accountableOf(owner.project, accountableId) : { developerId: accountableId };
  return { op: "set_owner", owner, ...(accountable === undefined ? {} : { accountable }) };
}

/**
 * Whom `change` would count the agent's budget for if it applied now, read as their survivor (M-3). A request was summed against one person (`forOwner`);
 * once the agent counts for someone else, approving it would raise that person's total with no cap, so it ends instead (`owner_moved`) and nothing applies.
 */
async function requireSameOwner(deps: SpendRequestDependencies, record: SpendRequestRecord, change: OwnerCapChange | undefined): Promise<void> {
  if (record.forOwner === undefined || change === undefined || change.op === "confirm_move") return;
  // The agent or chain the request is about (Plan 4: a chain's budget counts in the same owner total).
  const builtinAccountable = record.chainId === undefined && record.agentId !== undefined && isBuiltinAgentId(record.agentId) && change.op === "set_accountable";
  const agent = record.chainId !== undefined ? await deps.chains?.get(record.orgId, record.chainId)
    : builtinAccountable ? await deps.store.builtinBudgetSnapshot(record.orgId, record.agentId as never)
      : await deps.store.get(record.orgId, record.agentId as never);
  const after = agent === undefined ? undefined
    : change.op === "set_accountable" ? withBudgetFields(agent, { accountable: change.accountable })
      : change.op === "set_owner" ? withBudgetFields(agent, { owner: change.owner, ...(change.accountable === undefined ? {} : { accountable: change.accountable }) })
        : agent;
  const raw = after === undefined ? undefined : budgetOwnerOf(after);
  const now = raw === undefined ? undefined : await resolveSurvivor(deps, record.orgId, raw);
  if (now === await resolveSurvivor(deps, record.orgId, record.forOwner)) return;
  await expireOne(deps, record, "owner_moved");
  throw closed({ status: "EXPIRED", endedBecause: "owner_moved" });
}

/** Applies an approved `owner_cap` request's change (`recheckedChange`) through the store, with the request's own end in the same transaction. */
async function applyOwnerCap(deps: SpendRequestDependencies, record: SpendRequestRecord, change: OwnerCapChange | undefined, by: string, items: TransactItem[], decisionActor: BudgetActor): Promise<void> {
  const agentId = record.agentId as never;
  const destinationIds = change?.op === "set_accountable" ? [change.accountable.developerId]
    : change?.op === "set_owner" ? [...(change.owner.kind === "member" ? [change.owner.developerId] : []), ...(change.accountable === undefined ? [] : [change.accountable.developerId])] : [];
  const destinationChecks: TransactItem[] = [];
  const currentSubject = change?.op === "set_accountable" ? record.chainId !== undefined ? await deps.chains?.get(record.orgId, record.chainId) : isBuiltinAgentId(agentId) ? undefined : await deps.store.get(record.orgId, agentId) : undefined;
  const destinationOwner = change?.op === "set_owner" ? change.owner : currentSubject?.owner;
  const accountableProject = destinationOwner?.kind === "project" ? destinationOwner.project : undefined;
  for (const developerId of new Set(destinationIds)) {
    const role = await orgRoleOf(deps, record.orgId, developerId);
    if (role === undefined) throw staleApproval();
    destinationChecks.push(...budgetActorChecks(deps.tableName, record.orgId, { developerId, role }).slice(0, 2));
    if (accountableProject !== undefined && (change?.op === "set_accountable" || change?.op === "set_owner") && change.accountable?.developerId === developerId && role !== "owner" && role !== "admin") {
      const key = projectMemberKey(record.orgId, developerId, accountableProject), grant = await getItem(deps, key);
      if (grantRoleOf(grant) !== "maintainer") throw staleApproval();
      destinationChecks.push({ ConditionCheck: { TableName: deps.tableName, Key: key,
        ConditionExpression: "#destinationGrantRole = :destinationGrantRole AND #destinationProjectRole = :destinationProjectRole",
        ExpressionAttributeNames: { "#destinationGrantRole": "role", "#destinationProjectRole": "projectRole" },
        ExpressionAttributeValues: { ":destinationGrantRole": "developer", ":destinationProjectRole": "maintainer" } } });
    }
  }
  const options = { actor: decisionActor, overrideCap: { actor: decisionActor, destinationChecks, financialChecks: record.ownerFinancialTerms === undefined ? [] : ownerFinancialChecks(deps.tableName, record.orgId, record.ownerFinancialTerms, record), spendRequestId: record.spendRequestId, items, ...(change === undefined || change.op === "confirm_move" ? {} : { source: record.approvalSource }), closed: () => closed({ status: "APPROVED" }) } };
  if (change === undefined || change.op === "confirm_move") {
    const checks = budgetActorChecks(deps.tableName, record.orgId, decisionActor);
    const financial = record.ownerFinancialTerms === undefined ? [] : ownerFinancialChecks(deps.tableName, record.orgId, record.ownerFinancialTerms, record);
    try { await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [...items, ...financial, ...checks] })); }
    catch (error) {
      const failed = failedIndexes(error);
      if (failed !== undefined && [...failed].some(index => index >= items.length + financial.length)) throw budgetActorRefused();
      if (failed !== undefined && [...failed].some(index => index >= items.length)) throw staleApproval();
      throw error;
    }
    return;
  }
  if (record.chainId !== undefined) {
    // A chain's budget change: the same stored change, applied through the chain store, whose counter is the same owner total.
    if (deps.chains === undefined) throw notFound();
    const chainId = record.chainId;
    switch (change.op) {
      case "set_budget": await deps.chains.setBudget(record.orgId, chainId, change.budget.monthlyUsd === null ? undefined : change.budget.monthlyUsd, by, undefined, options); return;
      case "set_owner": await deps.chains.setOwner(record.orgId, chainId, change.owner, by, change.accountable, undefined, { overrideCap: options.overrideCap }); return;
      case "set_accountable": await deps.chains.setAccountable(record.orgId, chainId, change.accountable, by, undefined, { overrideCap: options.overrideCap }); return;
      case "unarchive": await deps.chains.unarchive(record.orgId, chainId, by, undefined, options); return;
    }
  }
  switch (change.op) {
    case "set_budget": {
      if (change.budget.maxPerRunUsd !== undefined && change.expectedMaxPerRunUsd === undefined) throw agentXError("AGENT_REVISION_CONFLICT", "This pending budget request predates per-run snapshots. Deny this request, then submit a new budget change for review.");
      await deps.store.setBudget(record.orgId, agentId, change.budget, by, undefined, { ...options,
        ...(change.budget.maxPerRunUsd === undefined || change.expectedMaxPerRunUsd === undefined ? {} : { expectedMaxPerRunUsd: change.expectedMaxPerRunUsd }), actor: decisionActor });
      return;
    }
    case "set_owner": await deps.store.setOwner(record.orgId, agentId, change.owner, by, change.accountable, undefined, { overrideCap: options.overrideCap }); return;
    case "set_accountable": await deps.store.setAccountable(record.orgId, agentId, change.accountable, by, undefined, { overrideCap: options.overrideCap }); return;
    case "unarchive": await deps.store.unarchive(record.orgId, agentId, by, undefined, options); return;
  }
}

/**
 * `decideSpendRequest(deps, caller, id, { requestId, decision, amountUsd? })`: approves (for `amountUsd`, by default what it asks) or denies a request. Who may is
 * read again for the final amount (`spendApprovers`); a request that is not PENDING, or whose time ran out, is `APPROVAL_CLOSED`. The decision is conditional on
 * the record still being PENDING, in one transaction with what it changes (a task's limit; for `owner_cap` the stored change, through the store), the end of the
 * request's index items, its audit and the decision's R18 item. Then the task goes on where it stopped. Its route goes through `requireDecideSession` only.
 */
export async function decideSpendRequest(deps: SpendRequestDependencies, caller: AgentCaller, spendRequestId: string, value: unknown): Promise<{ spendRequest: Record<string, unknown> }> {
  const parsed = DecideBodySchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "is not valid"}`);
  }
  const body: DecideSpendBody = { requestId: parsed.data.requestId, decision: parsed.data.decision, ...(parsed.data.amountUsd === undefined ? {} : { amountUsd: parsed.data.amountUsd }) };
  const mark: RequestMark = { orgId: caller.orgId, developerId: caller.developerId, requestId: body.requestId, fingerprint: fingerprintOf(spendRequestId, body) };
  const earlier = await readRequest(deps, caller.orgId, caller.developerId, body.requestId);
  if (earlier !== undefined) {
    if (earlier.fingerprint !== mark.fingerprint) throw agentXError("CONFIG_INVALID", "requestId: this request ID was already used for a different request");
    return earlier.result as { spendRequest: Record<string, unknown> };
  }
  const record = await getSpendRequest(deps, caller.orgId, spendRequestId);
  if (record === undefined) throw notFound();
  // An owner_cap request applies the change it holds: it has no amount to approve (M-7).
  const approvedUsd = body.decision === "APPROVE" && record.kind !== "owner_cap" ? cleanUsd(body.amountUsd ?? record.amountUsd) : undefined;
  // Who may is asked first, so a person who may not learns nothing about how it ended.
  const may = await mayDecideNow(deps, caller, record, approvedUsd);
  if (!may.allowed) throw agentXError("FORBIDDEN", `Only ${may.who} can decide this.`);
  if (record.kind === "owner_cap" && body.amountUsd !== undefined) throw agentXError("CONFIG_INVALID", "amountUsd: this request applies the change it holds, so it takes no amount");
  if (record.status !== "PENDING") throw closed(record);
  if (Date.parse(record.expiresAt) <= deps.now()) throw closed({ status: "EXPIRED" });
  const decidedBy = await resolveSurvivor(deps, caller.orgId, caller.developerId);
  const decidedAt = iso(deps.now());
  const status = body.decision === "APPROVE" ? "APPROVED" as const : "DENIED" as const;
  const decided: SpendRequestRecord = { ...record, status, decidedBy, decidedAt, ...(approvedUsd === undefined ? {} : { approvedAmountUsd: approvedUsd }) };
  const answer = { spendRequest: spendRequestView(deps, decided) };
  const events = await audited(deps, () => [auditSpendRequestDecided({
    orgId: record.orgId, actor: auditActorOf(decidedBy), occurredAt: decidedAt, occurrence: record.spendRequestId, ...facts(record),
    decision: status, proof: decisionProofOf(caller),
    // What was applied, which an approver may have set apart from what was asked (I-2); an owner_cap request applies its stored change and has no amount.
    ...(approvedUsd === undefined ? {} : { approvedAmountCents: centsOf(approvedUsd), appliedLimitCents: centsOf(newLimitFor(record, approvedUsd)), ...(record.kind === "month" ? { topUpMonth: monthOfRequest(record) } : {}) }),
  })]);
  const ending = [
    ...endItems(deps, record, { status, decidedBy, decidedAt, ...(approvedUsd === undefined ? {} : { approvedAmountUsd: approvedUsd }), ...(caller.decideProof === undefined ? {} : { decisionProof: caller.decideProof }) }),
    ...events.flatMap((event) => auditPending(deps, event)),
    requestMarkItem(deps, mark, answer),
  ];
  const refused = async (error: unknown): Promise<never> => {
    const failed = failedIndexes(error);
    if (failed === undefined) throw error;
    const now = await getSpendRequest(deps, caller.orgId, spendRequestId);
    if (now !== undefined && now.status !== "PENDING") throw closed(now);
    if (failed.has(ending.length - 1)) throw agentXError("IDEMPOTENCY_CONFLICT", "This request ID is already being used for another change.");
    if ((await readTask(deps, record.orgId, record.taskId))?.closedAt !== undefined) await closedTask();
    throw error instanceof AgentXError ? error : agentXError("AGENT_REVISION_CONFLICT", "The task changed while this was decided. Open the request again.");
  };
  // A closed task's request is ended, not refused as a conflict again and again until it expires (M-2).
  const closedTask = async (): Promise<never> => {
    await expireOne(deps, record, "task_closed");
    throw closed({ status: "EXPIRED", endedBecause: "task_closed" });
  };
  const survivorRole = decidedBy === caller.developerId ? caller.orgRole : await orgRoleOf(deps, caller.orgId, decidedBy);
  if (survivorRole === undefined) throw budgetActorRefused();
  const decisionActor: BudgetActor = { developerId: decidedBy, role: survivorRole,
    ...(decidedBy === caller.developerId ? {} : { signedIn: { developerId: caller.developerId, role: caller.orgRole } }),
  };
  if (record.kind === "month") return decideMonth(deps, record, may.approvers, { status, approvedUsd, answer, events, ending, mark, refused, actor: decisionActor });
  if (record.kind === "owner_cap") {
    if (record.ownerFinancialTerms !== undefined) {
      const source = expirySource(record), update = ending[0]?.Update;
      if (update === undefined) throw staleApproval();
      update.ConditionExpression = `(${update.ConditionExpression}) AND (${source.condition})`;
      update.ExpressionAttributeNames = { ...update.ExpressionAttributeNames, ...source.names };
      update.ExpressionAttributeValues = { ...update.ExpressionAttributeValues, ...source.values };
    }
    const change = status === "APPROVED" ? await recheckedChange(deps, caller, record) : undefined;
    if (status === "APPROVED") await requireSameOwner(deps, record, change);
    if (status === "APPROVED" && record.ownerFinancialTerms !== undefined) {
      const parsed = OwnerFinancialTermsSchema.safeParse(record.ownerFinancialTerms);
      const countedOwnerMoved = parsed.success && record.forOwner !== undefined && parsed.data.owner !== record.forOwner;
      if (!ownerApprovalTermsComplete(record) && !countedOwnerMoved) {
        await expireOne(deps, record, "spending_rules_changed", budgetActorChecks(deps.tableName, record.orgId, decisionActor));
        throw agentXError("SPENDING_APPROVAL_STALE", "Spending rules changed; ask again.");
      }
      const terms = parsed.success ? parsed.data : undefined;
      if (terms !== undefined) assertOwnerCarriedSource(terms, record.orgId, record);
      const base = terms?.basis === "base" ? await getItem(deps, ownerBudgetKey(record.orgId, terms.owner)) : undefined;
      const current = terms === undefined ? undefined : terms.basis === "base" ? { totalUsd: base?.totalUsd, counterUsd: base?.totalUsd, version: base === undefined ? undefined : base.version ?? 0 } : await effectiveOwnerCap(deps, record.orgId, terms.owner);
      const policy = await readSpendPolicyWithRevision(deps, record.orgId);
      const carried = terms?.carriedSource, currentCarried = carried === undefined ? undefined : await getItem(deps, carried.key);
      const carriedChanged = carried !== undefined && (carried.exists !== (currentCarried !== undefined) || canonicalJson(carried.fields) !== canonicalJson(currentCarried ?? {}));
      if (carriedChanged || terms === undefined || terms.owner !== record.forOwner || terms.month !== iso(deps.now()).slice(0, 7) || current?.version !== terms.counterVersion || current.totalUsd !== terms.totalUsd || current.counterUsd !== terms.counterUsd || policy.revision !== terms.policyRevision || policy.policy.ownerAgentBudgetCapUsd !== terms.capUsd) {
        await expireOne(deps, record, "figures_changed"); throw staleApproval();
      }
    }
    if (status === "APPROVED" && change !== undefined && change.op !== "confirm_move") {
      const parsedSource = ApprovalSourceSchema.safeParse(record.approvalSource);
      const source = parsedSource.success ? parsedSource.data : undefined;
      const key = record.chainId !== undefined ? chainKey(record.orgId, record.chainId, "META") : isBuiltinAgentId(record.agentId as never) ? builtinSettingsKey(record.orgId, record.agentId as never) : agentKey(record.orgId, record.agentId as never, "META");
      const current = await getItem(deps, key);
      if (source?.version !== 1 || source.key.pk !== key.pk || source.key.sk !== key.sk || source.exists !== (current !== undefined) || canonicalJson(source.fields) !== canonicalJson(sourceFields(current))) {
        await expireOne(deps, record, "figures_changed"); throw staleApproval();
      }
    }
    try {
      await applyOwnerCap(deps, record, change, decidedBy, ending, decisionActor);
    } catch (error) {
      if (error instanceof AgentXError && error.code === "SPENDING_APPROVAL_STALE") await expireOne(deps, record, "figures_changed");
      if (error instanceof AgentXError) throw error;
      await refused(error);
    }
    await flushAuditEvents(deps, events);
    return answer;
  }
  let task = status === "APPROVED" && record.taskId !== undefined ? await readTask(deps, record.orgId, record.taskId) : undefined;
  if (status === "APPROVED" && record.taskId !== undefined && task === undefined) throw notFound();
  if (task?.closedAt !== undefined) await closedTask();
  let approvalStop: CapturedTaskStop | undefined;
  let approvalTerms: TaskApprovalTerms | undefined;
  if (status === "APPROVED" && approvedUsd !== undefined && task !== undefined && (record.kind === "run_limit" || record.kind === "max_per_run" || record.kind === "planning")) {
    const previous = task.spendingStop === undefined ? undefined : checkedTaskStopSnapshot(task.spendingStop);
    // This is a new approval, not a retrofit of the task's committed window.
    // Disabled/unseeded orgs retain the existing decision path. Eligibility was
    // checked above and is rechecked after source reads by the same decider.
    const captured = await captureTaskStopAdmission({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, requireScopeAccess: async () => {
      if (!(await mayDecideNow(deps, caller, record, approvedUsd)).allowed) throw budgetActorRefused();
    } }, { orgId: record.orgId, developerId: decisionActor.developerId, role: decisionActor.role, project: task.project,
      agentId: task.agent?.agentId ?? ROVARA_CODE_AGENT_ID, ...savedTaskStopBounds(previous),
      ...(record.kind === "max_per_run" || task.maxPerRunUsd === undefined ? {} : { committedMaxPerRunMicrousd: usdToWholeMicrodollars(task.maxPerRunUsd) ?? null }),
      pathLimitMicrousd: record.kind === "max_per_run" ? taskRunLimitMicrousd(task) ?? null : previous?.calculationInput.pathLimitMicrousd ?? usdToWholeMicrodollars(task.budgetUsd ?? PER_TASK_BUDGET_USD) ?? null,
    });
    if (captured.kind === "captured") {
      const parsedTerms = TaskApprovalTermsSchema.safeParse(record.approvalTerms);
      if (!parsedTerms.success || !taskApprovalRecordMatches(parsedTerms.data, record) || parsedTerms.data.policyDigest !== taskApprovalPolicyDigest(captured)) {
        await expireOne(deps, record, "spending_rules_changed"); throw agentXError("SPENDING_APPROVAL_STALE", "Spending rules changed; ask again.");
      }
      if (!taskApprovalSourceMatches(parsedTerms.data, task)) { await expireOne(deps, record, "figures_changed"); throw staleApproval(); }
      approvalTerms = parsedTerms.data;
      const approved = approveCapturedTaskStop(captured, usdToWholeMicrodollars(newLimitFor(record, approvedUsd)) ?? null, "run_limit", "approval_allowance");
      if (approved.effectiveStopMicrousd !== usdToWholeMicrodollars(newLimitFor(record, approvedUsd))) {
        await expireOne(deps, record, "spending_rules_changed");
        throw agentXError("SPENDING_APPROVAL_STALE", "Spending rules changed; ask again.");
      }
      approvalStop = approveCapturedTaskStop(captured, usdToWholeMicrodollars(newLimitFor(record, approvedUsd)) ?? null, record.kind === "max_per_run" ? "max_per_run" : "run_limit");
    }
  }
  const originalRequestIndex = approvalTerms === undefined ? undefined : pinTaskApprovalRequest(ending, record);
  /** What the approval writes on `current`, and what follows it. */
  const plan = async (current: DeveloperTaskRecord | undefined) => {
    const change = current === undefined || approvedUsd === undefined ? undefined : await taskChange(deps, record, current, approvedUsd, approvalStop);
    let followUp: Omit<CreateSpendRequestInput, "reason"> | undefined;
    let followUpWords: string | undefined;
    const extra: TransactItem[] = [];
    if (current !== undefined && change?.raisedPastRunLimit !== undefined) {
      followUp = followUpRunLimit(current, change.raisedPastRunLimit);
      const draft = { ...record, ...followUp, spendRequestId: record.spendRequestId, reason: "", status: "PENDING" } as SpendRequestRecord;
      const asked = await spendApprovers(deps, draft);
      followUpWords = askedWords(asked.role);
      extra.push(taskEventItem(deps, current, decidedAt, `spr${record.spendRequestId}d`,
        `That is more than this run's ${dollars(change.raisedPastRunLimit)} run limit, so I also asked ${followUpWords} to raise it.`));
    }
    const admission = current === undefined || approvalStop === undefined || change?.resume !== true ? undefined
      : await deps.spendRequests?.prepareApprovalAdmission?.({ orgId: record.orgId, taskId: current.taskId, decisionRequestId: body.requestId, spendRequestId: record.spendRequestId, snapshot: approvalStop, budgetBaselineUsd: change.budgetBaselineUsd });
    const admissionStart = extra.length;
    if (admission?.taskReference === true) {
      const update = change?.items.find(item => item.Update?.Key?.pk === taskKey(current!.taskId).pk && item.Update.Key.sk === "META")?.Update;
      if (update === undefined || update.UpdateExpression === undefined) throw budgetActorRefused();
      const parts = update.UpdateExpression.split(" REMOVE ");
      update.UpdateExpression = `${parts[0]}, spendingAdmission = :approvalAdmission${parts[1] === undefined ? "" : ` REMOVE ${parts[1]}`}`;
      update.ExpressionAttributeValues = { ...update.ExpressionAttributeValues, ":approvalAdmission": admission.reference };
      if (admission.workflowRevision !== undefined) {
        update.ConditionExpression = `(${update.ConditionExpression ?? "attribute_exists(pk)"}) AND workflow.revision = :approvalWorkflowRevision`;
        update.ExpressionAttributeValues[":approvalWorkflowRevision"] = admission.workflowRevision;
      }
    }
    if (admission !== undefined) extra.push(...admission.items);
    // A run held at its start is dispatched by the resume; the due item lets the settlement run try again if that fails now (M-1).
    // A plan blocked on its run limit (`resume: "implement"`) is started by the same list: the approval commits the limit, the start is made after it, and a start
    // that was lost is made again by the settlement run (the only way to unblock the plan is this approval, so it must not be lost).
    const implementing = current !== undefined && change?.resume === true && record.kind === "run_limit" && record.resume === "implement" && approvedUsd !== undefined;
    const held = current !== undefined && change?.resume === true && (change.firstDispatch || implementing || admission !== undefined) ? heldStartKey(decidedAt, record.orgId, current.taskId) : undefined;
    const runLimitUsd = implementing && approvedUsd !== undefined ? newLimitFor(record, approvedUsd) : undefined;
    if (held !== undefined && change !== undefined) {
      extra.push({ Put: { TableName: deps.tableName, Item: {
        ...held, entityType: "SPEND_HELD_START", orgId: record.orgId, taskId: record.taskId, spendRequestId: record.spendRequestId, resetRunWindow: change.resetRunWindow, expiresAt: record.expiresAt,
        ...(admission === undefined ? {} : { spendingAdmission: admission.reference, expectedPausedAgentRevision: admission.expectedPausedAgentRevision }),
        ...(runLimitUsd === undefined ? {} : { resume: "implement", runLimitUsd }),
      } } });
      // "Approved, starting" for the task: while it stands the owner is not offered another ask (it is removed with the held start).
      if (runLimitUsd !== undefined) {
        extra.push({ Put: { TableName: deps.tableName, Item: { ...heldPlanStartKey(record.orgId, current!.taskId), entityType: "SPEND_HELD_PLAN_START", orgId: record.orgId, taskId: current!.taskId, spendRequestId: record.spendRequestId, expiresAt: record.expiresAt } } });
      }
    }
    return { change, followUp, followUpWords, extra, held, runLimitUsd, admission, admissionStart };
  };
  const pauseOf = (current: DeveloperTaskRecord) => `${current.budgetPause?.scope.kind ?? ""}|${current.budgetPause?.firstDispatch?.operationId ?? ""}`;
  let planned = await plan(task);
  for (let attempt = 0; ; attempt += 1) {
    const items = [...ending, ...(planned.change?.items ?? []), ...planned.extra];
    const originalSourceIndex = approvalTerms === undefined ? undefined : pinTaskApprovalSource(deps.tableName, items, approvalTerms);
    const actorStart = items.length;
    for (const guard of [...budgetActorChecks(deps.tableName, record.orgId, decisionActor), ...(planned.admission?.authority ?? [])]) {
      const key = guard.ConditionCheck?.Key;
      const existing = items.find(item => { const other = item.ConditionCheck?.Key ?? item.Update?.Key ?? item.Put?.Item ?? item.Delete?.Key; return key !== undefined && other !== undefined && other.pk === key.pk && other.sk === key.sk; });
      if (existing !== undefined) { if (canonicalJson(existing) !== canonicalJson(guard)) throw budgetActorRefused(); }
      else items.push(guard);
    }
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
      break;
    } catch (error) {
      const failed = failedIndexes(error);
      if (failed !== undefined && [...failed].some((index) => index >= actorStart)) throw budgetActorRefused();
      if (planned.admission !== undefined) {
        const start = ending.length + (planned.change?.items.length ?? 0) + planned.admissionStart;
        if (failed?.has(start + planned.admission.receiptIndex)) throw agentXError("IDEMPOTENCY_CONFLICT", "This request ID already names another spending admission.");
        if (planned.admission.runSourceIndex !== undefined && failed?.has(start + planned.admission.runSourceIndex)) { await expireOne(deps, record, "figures_changed"); throw staleApproval(); }
      }
      if (originalRequestIndex !== undefined && failed?.has(originalRequestIndex)) {
        const currentRequest = await getSpendRequest(deps, record.orgId, record.spendRequestId);
        if (currentRequest?.status === "PENDING") { await expireOne(deps, currentRequest, "figures_changed"); throw staleApproval(); }
      }
      if (approvalTerms !== undefined && originalSourceIndex !== undefined && failed?.has(originalSourceIndex)) {
        const current = await readTask(deps, record.orgId, task!.taskId);
        if (current === undefined || !taskApprovalSourceMatches(approvalTerms, current)) { await expireOne(deps, record, "figures_changed"); throw staleApproval(); }
      }
      // Only the pause moved since it was read (the owner went on, another limit paused it): the approval is made again on the task as it is now, once (I-3).
      const now = attempt === 0 && task !== undefined && failedIndexes(error) !== undefined ? await readTask(deps, record.orgId, task.taskId) : undefined;
      if (task !== undefined && now !== undefined && now.closedAt === undefined && now.budgetUsd === task.budgetUsd && now.maxPerRunUsd === task.maxPerRunUsd && pauseOf(now) !== pauseOf(task)) {
        task = now;
        planned = await plan(now);
        continue;
      }
      await refused(error);
    }
  }
  const { change, followUp, followUpWords, held, runLimitUsd, admission } = planned;
  await flushAuditEvents(deps, events);
  if (task !== undefined && change !== undefined) {
    if (followUp !== undefined && followUpWords !== undefined) {
      const words = followUpWords;
      const made = await createSpendRequest(deps, { ...followUp, reason: `This task needs about ${dollars(followUp.amountUsd)} more to finish. I asked ${words} to approve it.` })
        .catch((error: unknown) => { logLine(deps, "spend_request.follow_up_failed", { spendRequestId: record.spendRequestId, error: errorName(error) }); return undefined; });
      void made;
    }
    // The decision stands whatever happens next; a resume that fails is logged, and the owner's Continue (or the engine's sweep) goes on from the raised limit.
    // A held start's failure is said on the task, and the settlement run tries it again (`retryHeldStarts`).
    if (change.resume) {
      try {
        await deps.spendRequests?.resumeTask({
          orgId: record.orgId, taskId: task.taskId, spendRequestId: record.spendRequestId, resetRunWindow: change.resetRunWindow, firstDispatch: change.firstDispatch,
          ...(admission === undefined ? {} : { spendingAdmission: admission.reference, expectedPausedAgentRevision: admission.expectedPausedAgentRevision }),
          ...(runLimitUsd === undefined ? {} : { resume: "implement" as const, runLimitUsd }),
        });
        if (held !== undefined) await clearHeldStart(deps, held, record.orgId, task.taskId, false, runLimitUsd !== undefined);
      } catch (error) {
        logLine(deps, "spend_request.resume_failed", { spendRequestId: record.spendRequestId, taskId: task.taskId, error: errorName(error) });
        if (held !== undefined) {
          await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [taskEventItem(deps, task, decidedAt, `spr${record.spendRequestId}h`, HELD_START_WAITING)] }))
            .catch(() => undefined);
        }
      }
    }
  }
  return answer;
}

/**
 * A `month` decision on `approvers`, the one read that authorised the caller (fix round 1, C-1). An approval ADDs the top-up for the scope and the request's
 * month, in the transaction that ends the request; an agent's also moves the owner counter's `version`. When that read routed it to the agent's owner, the
 * approval applies only while the version is the one the owner's total was summed at and the spend policy is at the revision its cap was read from (R4-6,
 * M-9). A lost race re-reads the total once and re-routes the request (to the admins when it is now over the cap), applying nothing. An agent's approval
 * whose new limit the guardrail would clamp is refused: it could not take effect (I-4). Then every task the budget stopped goes on.
 */
async function decideMonth(deps: SpendRequestDependencies, record: SpendRequestRecord, approvers: SpendApprovers, decision: {
  actor: BudgetActor; status: "APPROVED" | "DENIED"; approvedUsd: number | undefined; answer: { spendRequest: Record<string, unknown> }; events: AuditEventInput[]; ending: TransactItem[]; mark: RequestMark; refused: (error: unknown) => Promise<never>;
}): Promise<{ spendRequest: Record<string, unknown>; rerouted?: boolean }> {
  const scope = record.scope;
  if (!isBudgetScope(scope)) throw notFound();
  const items = [...decision.ending];
  const held: number[] = [];
  // An admin's agent top-up is held to the owner counter's version and the top-up it checked the guardrail on (fix round 2, minor 2): of two that race, the
  // one that loses is refused, the request stays PENDING, and deciding it again checks the live limit.
  const raced: number[] = [];
  if (decision.status === "APPROVED" && decision.approvedUsd !== undefined) {
    const month = monthOfRequest(record);
    // An agent's and a chain's budgets are in their owner's one total: the same version, cap and guardrail hold for both.
    const owned = scope.kind === "agent" || scope.kind === "chain";
    // The owner's read must carry what it summed at; an owner's route without it is not decided on (fail closed).
    if (owned && (approvers.role === "agent_owner" || approvers.role === "chain_owner") && approvers.owner === undefined) throw agentXError(scope.kind === "chain" ? "CHAIN_REVISION_CONFLICT" : "AGENT_REVISION_CONFLICT", "This request changed while it was decided. Open it again.");
    const adminOwner = owned && approvers.owner === undefined ? (scope.kind === "agent" ? await agentBudgetOwner(deps, record.orgId, scope.agentId) : await chainBudgetOwner(deps, record.orgId, scope.chainId)) : undefined;
    // Read before the limit, so a base raise or top-up after it moves the version the write is held to.
    const adminVersion = adminOwner === undefined ? undefined : await ownerCounterVersion(deps, record.orgId, adminOwner);
    let seenTopUp: number | undefined;
    if (owned) {
      const parts = scope.kind === "agent" ? await agentLimitParts(deps, record.orgId, month, scope.agentId) : await chainLimitParts(deps, record.orgId, month, scope.chainId);
      if (approvers.owner === undefined) seenTopUp = parts.topUpUsd;
      const limit = cleanUsd(parts.limitUsd + decision.approvedUsd);
      const guardrail = (await readGuardrails(deps, record.orgId)).maxAgentMonthlyUsd;
      if (limit > guardrail) {
        throw agentXError("CONFIG_INVALID", scope.kind === "chain"
          ? `amountUsd: that would take this chain to ${dollars(limit)} a month, past the ${dollars(guardrail)} a chain may have. Approve less, or raise the agent guardrail first.`
          : `amountUsd: that would take this agent to ${dollars(limit)} a month, past the ${dollars(guardrail)} an agent may have. Approve less, or raise the agent guardrail first.`);
      }
    }
    if (seenTopUp !== undefined) raced.push(items.length);
    items.push({
      Update: {
        TableName: deps.tableName, Key: topUpKey(record.orgId, month, scope),
        UpdateExpression: "SET entityType = :type, orgId = :org, updatedAt = :now ADD amountUsd :amount",
        ExpressionAttributeValues: {
          ":type": "TOPUP", ":org": record.orgId, ":now": iso(deps.now()), ":amount": decision.approvedUsd,
          ...(seenTopUp === undefined ? {} : seenTopUp === 0 ? { ":zero": 0 } : { ":seen": seenTopUp }),
        },
        ...(seenTopUp === undefined ? {} : { ConditionExpression: seenTopUp === 0 ? "attribute_not_exists(amountUsd) OR amountUsd <= :zero" : "amountUsd = :seen" }),
      },
    });
    if (owned) {
      const owner = approvers.owner?.developerId ?? adminOwner;
      if (owner !== undefined) {
        await deps.store.ensureOwnerTotal(record.orgId, owner);
        (approvers.owner !== undefined ? held : raced).push(items.length);
        items.push(ownerVersionItem(deps, record.orgId, owner, approvers.owner?.version ?? adminVersion));
      }
      if (approvers.owner !== undefined) {
        const revision = approvers.owner.policyRevision;
        held.push(items.length);
        items.push({
          ConditionCheck: {
            TableName: deps.tableName, Key: orgSettingsKey(record.orgId, "SPEND_POLICY"),
            ...(revision === 0 ? { ConditionExpression: "attribute_not_exists(pk)" }
              : { ConditionExpression: "#revision = :revision", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":revision": revision } }),
          },
        });
      }
    }
  }
  const actorStart = items.length;
  items.push(...budgetActorChecks(deps.tableName, record.orgId, decision.actor));
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    const failed = failedIndexes(error);
    if (failed !== undefined && [...failed].some((index) => index >= actorStart)) throw budgetActorRefused();
    if (failed !== undefined && held.some((index) => failed.has(index)) && !failed.has(0)) {
      return (await reroute(deps, record, decision.mark)).answer;
    }
    if (failed !== undefined && raced.some((index) => failed.has(index)) && !failed.has(0)) {
      throw agentXError(scope.kind === "chain" ? "CHAIN_REVISION_CONFLICT" : "AGENT_REVISION_CONFLICT", `This ${scope.kind === "chain" ? "chain" : "agent"}'s budget changed while you decided. Open the request again: it is checked on the budget as it is now.`);
    }
    await decision.refused(error);
  }
  await flushAuditEvents(deps, decision.events);
  if (decision.status === "APPROVED") await resumeMonthTasks(deps, record, scope);
  return decision.answer;
}

/** Whose total a chain's budget counts in: its member owner, else its accountable maintainer, read as their survivor. */
async function chainBudgetOwner(deps: SpendRequestDependencies, orgId: OrgId, chainId: string): Promise<string | undefined> {
  const chain = await deps.chains?.get(orgId, chainId);
  const raw = chain === undefined ? undefined : budgetOwnerOf(chain);
  return raw === undefined ? undefined : resolveSurvivor(deps, orgId, raw);
}

/** Whose total an agent's budget counts in: its member owner, else its accountable maintainer, read as their survivor. */
async function agentBudgetOwner(deps: SpendRequestDependencies, orgId: OrgId, agentId: string): Promise<string | undefined> {
  if (isBuiltinAgentId(agentId)) return undefined;
  const agent = await deps.store.get(orgId, agentId);
  const raw = agent === undefined ? undefined : budgetOwnerOf(agent);
  return raw === undefined ? undefined : resolveSurvivor(deps, orgId, raw);
}

/**
 * The owner's total moved while the request was being approved (R4-6): the approvers are read again, once, and the request is routed to them (to the admins
 * when the total with the top-up is now over the cap), conditional on it still being PENDING, audited as the system's `spend_request.rerouted`. Nothing applies.
 */
async function reroute(deps: SpendRequestDependencies, record: SpendRequestRecord, mark: RequestMark): Promise<{ record: SpendRequestRecord; answer: { spendRequest: Record<string, unknown>; rerouted: true } }> {
  const approvers = await spendApprovers(deps, record);
  const rerouted = { ...record, approverRole: approvers.role, approverIds: approvers.ids };
  // The decision's R18 mark carries the answer the rerouted decision gave (M-2), so a repeat of it answers that and is not decided again on the new route.
  const answer = { spendRequest: spendRequestView(deps, rerouted), rerouted: true as const };
  const at = iso(deps.now());
  const events = await audited(deps, () => [auditSpendRequestRerouted({
    orgId: record.orgId, actor: auditActorOf("system"), occurredAt: at, occurrence: auditOccurrence(record.spendRequestId, `recount-${at}`), spendRequestId: record.spendRequestId,
    kind: record.kind, mode: "recounted", from: record.approverRole, to: approvers.role,
  })]);
  await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
    {
      Update: {
        TableName: deps.tableName, Key: spendRequestKey(record.orgId, record.spendRequestId),
        UpdateExpression: `SET approverRole = :role, approverIds = :ids${approvers.owner === undefined ? " REMOVE ownerVersion" : ", ownerVersion = :version"}`,
        ConditionExpression: "#status = :pending", ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":role": approvers.role, ":ids": approvers.ids, ":pending": "PENDING", ...(approvers.owner === undefined ? {} : { ":version": approvers.owner.version }) },
      },
    },
    { Put: { TableName: deps.tableName, Item: { ...openSpendRequestsKey(record.orgId, record.createdAt, record.spendRequestId), entityType: "SPEND_REQUEST_OPEN", orgId: record.orgId, spendRequestId: record.spendRequestId, approverIds: approvers.ids } } },
    ...events.flatMap((event) => auditPending(deps, event)),
    requestMarkItem(deps, mark, answer),
  ] })).catch((error: unknown) => {
    if (failedIndexes(error)?.has(3 + events.length) === true) throw agentXError("IDEMPOTENCY_CONFLICT", "This request ID is already being used for another change.");
    throw error;
  });
  await flushAuditEvents(deps, events);
  return { record: rerouted, answer };
}

// ---- the settlement run: escalation and expiry (PF13), held starts (fix round 1, M-1)

/** What a held start's task says when its approval could not dispatch it at once. */
const HELD_START_WAITING = "The budget was approved, but this run couldn't start yet. Rovara will keep trying.";
const HELD_STARTS = "HELD_SPEND_STARTS";
/** The most of a settlement run the held-start retries may take (they get at most a quarter of it). */
const HELD_STARTS_BUDGET_MS = 500;
/**
 * A run held at its start whose approval committed: kept until the run is dispatched, the task closes, or the request's time would have run out. A month's
 * approval keeps one per task it un-paused here too (`resume: "month"`), until that task went on.
 */
const heldStartKey = (at: string, orgId: OrgId, taskId: string) => ({ pk: HELD_STARTS, sk: `${at}#${orgId}#${taskId}` });

/** Removes a held start's item once its run was dispatched (its pause is gone) or its task closed; `giveUp` removes it whatever the task is. */
async function clearHeldStart(deps: SpendRequestDependencies, key: { pk: string; sk: string }, orgId: OrgId, taskId: string, giveUp = false, planStart = false): Promise<boolean> {
  const task = await readTask(deps, orgId, taskId);
  if (!giveUp && task?.budgetPause?.firstDispatch !== undefined && task.closedAt === undefined) return false;
  // A plan's run limit start also removes its "approved, starting" marker.
  await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
    { Delete: { TableName: deps.tableName, Key: key } },
    ...(planStart ? [{ Delete: { TableName: deps.tableName, Key: heldPlanStartKey(orgId, taskId) } }] : []),
  ] }));
  return true;
}

/** The refusals a resume gives when its creator was removed (R60) or its owner can't act in the org. They are also what an unreadable access proof gives, so `creatorGone` confirms before an item is dropped. */
const MEMBER_LEFT_CODES = new Set(["TASK_ACCESS_DENIED", "FORBIDDEN"]);
const memberLeft = (error: unknown): boolean => MEMBER_LEFT_CODES.has(String((error as { code?: unknown } | undefined)?.code));

/** Whether a task's creator is really gone from its org: no member record, and the removal's tombstone is there (the check R60's `requireCreatorStillMember` makes). */
async function creatorGone(deps: Pick<SpendRequestDependencies, "documentClient" | "tableName">, orgId: OrgId, task: DeveloperTaskRecord): Promise<boolean> {
  // The owner now (Plan 5 Task 12a): the person who took the task over, else its creator. A task whose owner can't be read is gone for no one here: nothing is dropped.
  const owner = tryEffectiveTaskOwner(task);
  if (owner === undefined) return false;
  if (await getItem(deps, orgMemberKey(orgId, owner.developerId)) !== undefined) return false;
  return await getItem(deps, orgRemovedKey(orgId, owner.developerId)) !== undefined;
}

/** Drops a month resume that can never go on (fix round 2, minor 1), audited as the system's `spend_request.resume_dropped` in the same transaction. */
async function dropMonthResume(deps: SpendRequestDependencies, key: { pk: string; sk: string }, orgId: OrgId, taskId: string, spendRequestId: string): Promise<void> {
  const events = await audited(deps, () => [auditSpendRequestResumeDropped({
    orgId, actor: auditActorOf("system"), occurredAt: iso(deps.now()), occurrence: key.sk, spendRequestId, taskId, kind: "month", cause: "member_left",
  })]);
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Delete: { TableName: deps.tableName, Key: key, ConditionExpression: "attribute_exists(pk)" } }, ...events.flatMap((event) => auditPending(deps, event)),
    ] }));
  } catch (error) {
    // Another sweep dropped it, or the task went on, first.
    if (failedIndexes(error)?.has(0) === true) return;
    throw error;
  }
  await flushAuditEvents(deps, events);
  logLine(deps, "spend_request.month_resume_dropped", { spendRequestId, taskId });
}

/** Dispatches again every held start whose approval could not, oldest first, until `deadline`. Answers how many were dispatched, and whether all were seen. */
async function retryHeldStarts(deps: SpendRequestDependencies, deadline: number): Promise<{ dispatched: number; complete: boolean }> {
  const host = deps.spendRequests;
  let dispatched = 0;
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": HELD_STARTS }, ConsistentRead: true, Limit: PAGE,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      if (deps.now() >= deadline) return { dispatched, complete: false };
      const key = { pk: String(item["pk"]), sk: String(item["sk"]) };
      const orgId = item["orgId"];
      const taskId = item["taskId"];
      const spendRequestId = item["spendRequestId"];
      if (typeof orgId !== "string" || typeof taskId !== "string" || typeof spendRequestId !== "string") continue;
      const task = await readTask(deps, orgId, taskId);
      const expired = typeof item["expiresAt"] !== "string" || Date.parse(item["expiresAt"]) <= deps.now();
      if (item["spendingAdmission"] !== undefined) {
        const reference = SpendingAdmissionReferenceSchema.safeParse(item["spendingAdmission"]);
        if (!reference.success) { logLine(deps, "spend_request.invalid_admission_reference", { spendRequestId, taskId }); continue; }
        if (task === undefined || task.closedAt !== undefined || expired || host === undefined) {
          if (host !== undefined || expired) await clearHeldStart(deps, key, orgId, taskId, false).catch(() => false);
          continue;
        }
        try {
          const implementing = item["resume"] === "implement", runLimitUsd = item["runLimitUsd"];
          if (item["resume"] !== undefined && !implementing) throw agentXError("TASK_STOP_CONFIG_INVALID", "The approved recovery intent is invalid.");
          if (implementing && (typeof runLimitUsd !== "number" || !Number.isFinite(runLimitUsd) || runLimitUsd <= 0 || usdToWholeMicrodollars(runLimitUsd) === undefined)) throw agentXError("TASK_STOP_CONFIG_INVALID", "The approved implementation limit is invalid.");
          await host.resumeTask({ orgId, taskId, spendRequestId, resetRunWindow: item["resetRunWindow"] === true, firstDispatch: task.budgetPause?.firstDispatch !== undefined, spendingAdmission: reference.data,
            ...(implementing && typeof runLimitUsd === "number" ? { resume: "implement", runLimitUsd } : {}) });
          if (await clearHeldStart(deps, key, orgId, taskId, false)) dispatched += 1;
        } catch (error) { logLine(deps, "spend_request.admission_resume_failed", { spendRequestId, taskId, error: errorName(error) }); }
        continue;
      }
      if (item["resume"] === "month") {
        // A month's resume (Task 33 fix round 1, I-5): done once the task closed or paused again (it went on, or something else stopped it).
        if (task === undefined || task.closedAt !== undefined || task.budgetPause !== undefined || expired || host === undefined) {
          if (expired && task?.closedAt === undefined && task?.budgetPause === undefined) logLine(deps, "spend_request.month_resume_gave_up", { spendRequestId, taskId });
          if (host !== undefined || expired) await clearHeldStart(deps, key, orgId, taskId, true).catch(() => false);
          continue;
        }
        try {
          await host.resumeTask({ orgId, taskId, spendRequestId, resetRunWindow: false, firstDispatch: false });
          if (await clearHeldStart(deps, key, orgId, taskId, true)) dispatched += 1;
        } catch (error) {
          // Dropped only when the creator is really gone (as for a plan's run-limit start): a refusal of access that could not be verified keeps the item until it expires.
          if (memberLeft(error) && await creatorGone(deps, orgId, task)) await dropMonthResume(deps, key, orgId, taskId, spendRequestId).catch(() => undefined);
          else logLine(deps, "spend_request.month_resume_failed", { spendRequestId, taskId, error: errorName(error) });
        }
        continue;
      }
      if (item["resume"] === "implement") {
        // A plan's run limit that was approved (Task 34): done once the task closed, or its time ran out; the resume itself is a no-op for a plan that is no longer blocked on it.
        const runLimitUsd = item["runLimitUsd"];
        if (task === undefined || task.closedAt !== undefined || expired || host === undefined || typeof runLimitUsd !== "number") {
          if (expired && task?.closedAt === undefined) logLine(deps, "spend_request.run_limit_start_gave_up", { spendRequestId, taskId });
          if (host !== undefined || expired) await clearHeldStart(deps, key, orgId, taskId, true, true).catch(() => false);
          continue;
        }
        try {
          const outcome = await host.resumeTask({ orgId, taskId, spendRequestId, resetRunWindow: true, firstDispatch: false, resume: "implement", runLimitUsd });
          // A plan that was no longer blocked on its limit (STALE) clears the item, and was not started now.
          if (await clearHeldStart(deps, key, orgId, taskId, true, true) && outcome !== "STALE") dispatched += 1;
        } catch (error) {
          // Dropped only when the creator is really gone (R60): any other refusal, including a task-access proof that could not be read (a transport failure,
          // a brief loss of channel access), keeps the item, which tries again until the request's time runs out. The plan has no other way to start.
          if (memberLeft(error) && await creatorGone(deps, orgId, task)) await clearHeldStart(deps, key, orgId, taskId, true, true).catch(() => false);
          logLine(deps, "spend_request.run_limit_start_failed", { spendRequestId, taskId, error: errorName(error) });
        }
        continue;
      }
      if (task?.budgetPause?.firstDispatch === undefined || task.closedAt !== undefined || expired || host === undefined) {
        if (expired && task?.budgetPause?.firstDispatch !== undefined) logLine(deps, "spend_request.held_start_gave_up", { spendRequestId, taskId });
        if (host !== undefined || expired) await clearHeldStart(deps, key, orgId, taskId, expired).catch(() => false);
        continue;
      }
      try {
        await host.resumeTask({ orgId, taskId, spendRequestId, resetRunWindow: item["resetRunWindow"] === true, firstDispatch: true });
        if (await clearHeldStart(deps, key, orgId, taskId)) dispatched += 1;
      } catch (error) {
        logLine(deps, "spend_request.held_start_failed", { spendRequestId, taskId, error: errorName(error) });
      }
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return { dispatched, complete: true };
}

/**
 * The settlement run's job: first the held starts an approval could not dispatch and the month resumes that did not go on (`heldStarts` counts the ones
 * that went on now), then every open request
 * in the order it is due (`dueAt`): one whose time ran out is EXPIRED (the task stays paused; an `owner_cap` change never applies); a `max_per_run` request
 * its owner has not answered for `OWNER_ANSWER_HOURS` gets the org's owners and admins added (`escalatedAt`). A request that never escalates is due at its
 * expiry, and an escalated one moves there, so neither is read again before then (M-5). Each change is conditional on the record being PENDING, audited in
 * the same transaction. Stops at `budgetMs` (logged, `complete: false`) or at the first request not yet due.
 */
export async function escalateOwnerRequests(deps: SpendRequestDependencies, options: { budgetMs: number }): Promise<{ escalated: number; expired: number; heldStarts: number; monthResumes: number; complete: boolean }> {
  const started = deps.now();
  const deadline = started + options.budgetMs;
  // The retries have their own small share of the run (fix round 2, minor 1): a long or slow list of them can't starve expiry and escalation.
  const held = await retryHeldStarts(deps, started + Math.min(HELD_STARTS_BUDGET_MS, options.budgetMs / 4));
  // A new month's room for the tasks the last month stopped (final fix wave, money I-3): a small share of its own, after the held starts.
  const rolled = await resumeRolledMonths(deps, deps.now() + Math.min(MONTH_RESUMES_BUDGET_MS, options.budgetMs / 4));
  const result = { escalated: 0, expired: 0, heldStarts: held.dispatched, monthResumes: rolled.resumed, complete: false };
  const incomplete = () => {
    logLine(deps, "spend_request.sweep_incomplete", { escalated: result.escalated, expired: result.expired, heldStarts: result.heldStarts });
    return result;
  };
  // The run is complete only when the retries were too; what they left is tried again first on the next run.
  const finished = () => (held.complete && rolled.complete ? result : incomplete());
  const now = deps.now();
  let start: Record<string, unknown> | undefined;
  for (;;) {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": "OPEN_SPEND_REQUESTS" }, ConsistentRead: true, Limit: PAGE,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      if (deps.now() >= deadline) return incomplete();
      // In due order: once a request is not due yet, neither is any later one.
      const due = typeof item["dueAt"] === "string" ? Date.parse(item["dueAt"]) : Date.parse(String(item["sk"]).split("#")[0] ?? "");
      if (due > now) {
        result.complete = held.complete && rolled.complete;
        return finished();
      }
      const orgId = item["orgId"];
      const id = item["spendRequestId"];
      if (typeof orgId !== "string" || typeof id !== "string") continue;
      const record = await getSpendRequest(deps, orgId, id);
      if (record === undefined || record.status !== "PENDING") {
        // A request that ended keeps no place in the due list.
        await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Delete: { TableName: deps.tableName, Key: { pk: String(item["pk"]), sk: String(item["sk"]) } } }] })).catch(() => undefined);
        continue;
      }
      try {
        if (Date.parse(record.expiresAt) <= now) {
          if (await expireOne(deps, record)) result.expired += 1;
        } else if (record.kind === "max_per_run" && record.escalatedAt === undefined && record.approverRole !== "org_admin") {
          if (await escalateOne(deps, record)) result.escalated += 1;
        } else {
          await dueAtExpiry(deps, record);
        }
      } catch (error) {
        logLine(deps, "spend_request.sweep_failed", { spendRequestId: record.spendRequestId, error: errorName(error) });
      }
    }
    start = page.LastEvaluatedKey;
    if (start === undefined) {
      result.complete = held.complete && rolled.complete;
      return finished();
    }
  }
}

/** Ends a request as EXPIRED (by its time, or early, `because`), audited in the same transaction. False when it was no longer PENDING. */
/** Exact ask and index source for a terminal stop/owner-cap expiry. A due-item
 * move must retry, otherwise ending the old due key could leave a live index. */
function expirySource(record: SpendRequestRecord) {
  const fields = ["orgId", "spendRequestId", "kind", "scope", "slotSubject", "taskId", "agentId", "chainId", "forOwner", "newOwner",
    "amountUsd", "newLimitUsd", "change", "approvalSource", "approvalTerms", "ownerFinancialTerms", "requestedBy", "requestedFor", "createdAt", "expiresAt", "dueAt"] as const;
  const source = record as unknown as Record<string, unknown>, names: Record<string, string> = {}, values: Record<string, unknown> = {};
  const terms = Object.fromEntries(fields.flatMap(field => source[field] === undefined ? [] : [[field, source[field]]]));
  const condition = fields.map((field, index) => {
    const name = `#expirySource${index}`, value = `:expirySource${index}`; names[name] = field;
    if (source[field] === undefined) return `attribute_not_exists(${name})`;
    values[value] = source[field]; return `${name} = ${value}`;
  }).join(" AND ");
  return { termsDigest: createHash("sha256").update(canonicalJson({ version: 1, terms })).digest("hex"), condition, names, values };
}

/** Read-only classification, never a maintenance receipt or an enrollment gate.
 * The bounded writer must bind the reviewed source/policy again at expiry. */
type CutoverApprovalReview = { kind: "retain" | "expire" | "not_applicable"; reason?: "spending_rules_changed"; policyDigest?: string };
export async function reviewTaskStopCutoverApproval(deps: SpendRequestDependencies, actor: AgentCaller, record: SpendRequestRecord): Promise<CutoverApprovalReview> {
  return reviewCutoverApproval(deps, actor, record);
}
async function reviewCutoverApproval(deps: SpendRequestDependencies, actor: AgentCaller, record: SpendRequestRecord, nativeGuards?: TransactItem[]): Promise<CutoverApprovalReview> {
  if (actor.orgId !== record.orgId || (actor.orgRole !== "owner" && actor.orgRole !== "admin") || await orgRoleOf(deps, actor.orgId, actor.developerId) !== actor.orgRole) throw budgetActorRefused();
  if (record.kind === "owner_cap" || record.kind === "month" || record.status !== "PENDING") return { kind: "not_applicable" };
  const terms = TaskApprovalTermsSchema.safeParse(record.approvalTerms);
  if (!terms.success || !taskApprovalRecordMatches(terms.data, record)) return { kind: "expire", reason: "spending_rules_changed" };
  const task = await readTask(deps, record.orgId, record.taskId);
  if (task === undefined) throw notFound();
  const previous = task.spendingStop === undefined ? undefined : checkedTaskStopSnapshot(task.spendingStop), agentId = task.agent?.agentId ?? ROVARA_CODE_AGENT_ID;
  const captureReview: (deps: Parameters<typeof previewTaskStopCutover>[0], value: unknown) => Promise<Awaited<ReturnType<typeof previewTaskStopCutover>> & { sourceChecks?: TransactItem[] }> = nativeGuards === undefined ? previewTaskStopCutover : captureTaskStopCutoverReview;
  const preview = await captureReview({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, requireScopeAccess: async () => {
    await requireNativeProjectWorkRole(deps, task, actor);
    await requireAgentAccess(deps, actor, agentId, task.agent?.version === "draft" ? "edit" : "use");
  } }, { orgId: record.orgId, developerId: actor.developerId, role: actor.orgRole, project: task.project, agentId, ...savedTaskStopBounds(previous),
    ...(record.kind === "max_per_run" || task.maxPerRunUsd === undefined ? {} : { committedMaxPerRunMicrousd: usdToWholeMicrodollars(task.maxPerRunUsd) ?? null }),
    pathLimitMicrousd: record.kind === "max_per_run" ? taskRunLimitMicrousd(task) ?? null : previous?.calculationInput.pathLimitMicrousd ?? usdToWholeMicrodollars(task.budgetUsd ?? PER_TASK_BUDGET_USD) ?? null });
  const snapshot = preview.snapshot, policyDigest = taskApprovalPolicyDigest(snapshot);
  if (nativeGuards !== undefined) {
    if (preview.sourceChecks === undefined) throw staleApproval();
    nativeGuards.push(...preview.sourceChecks);
    const fenced = withAdmittedTaskSource(deps.tableName, task, nativeGuards, "cutoverTask");
    nativeGuards.splice(0, nativeGuards.length, ...fenced.items);
  }
  if (!taskApprovalSourceMatches(terms.data, task) || terms.data.policyDigest !== policyDigest) return { kind: "expire", reason: "spending_rules_changed", policyDigest };
  const proposed = usdToWholeMicrodollars(newLimitFor(record, record.amountUsd));
  try {
    const approved = approveCapturedTaskStop(snapshot, proposed ?? null, "run_limit", "approval_allowance");
    return approved.effectiveStopMicrousd === proposed ? { kind: "retain", policyDigest } : { kind: "expire", reason: "spending_rules_changed", policyDigest };
  } catch (error) {
    if (error instanceof AgentXError && error.code === "TASK_STOP_APPROVAL_ABOVE_CEILING") return { kind: "expire", reason: "spending_rules_changed", policyDigest };
    throw error;
  }
}

/** One freshly reviewed complete task ask, expired as SYSTEM only while its
 * native actor, policy revisions and task remain the reviewed source. */
export async function expireTaskStopCutoverApproval(deps: SpendRequestDependencies, actor: AgentCaller, spendRequestId: string): Promise<{ kind: "expired" | "retain" | "not_applicable" | "retry" }> {
  const record = await getSpendRequest(deps, actor.orgId, spendRequestId);
  if (record === undefined) throw notFound();
  const guards: TransactItem[] = [], review = await reviewCutoverApproval(deps, actor, record, guards);
  if (review.kind !== "expire") return { kind: review.kind };
  // Legacy asks use the separately bounded missing-terms phase.
  if (guards.length === 0) throw staleApproval();
  return { kind: await expireOne(deps, record, "spending_rules_changed", guards) ? "expired" : "retry" };
}

/** Explicit maintenance phase for old asks without complete terms. This does
 * not enroll an org or certify ceiling/cutover readiness. The controller retains
 * the returned native cursor; each expiry already has an immutable receipt. */
/** Owner monthly figures are reviewed independently of the task ceiling. */
export async function expireOwnerCapCutoverApproval(deps: SpendRequestDependencies, actor: AgentCaller, spendRequestId: string): Promise<{ kind: "retain" | "expired" | "retry" | "not_applicable" }> {
  if (actor.orgRole !== "owner" && actor.orgRole !== "admin") throw budgetActorRefused();
  const record = await getSpendRequest(deps, actor.orgId, spendRequestId);
  if (record === undefined) throw notFound();
  if (record.kind !== "owner_cap" || record.status !== "PENDING") return { kind: "not_applicable" };
  if (!ownerApprovalTermsComplete(record)) return { kind: await expireOne(deps, record, "spending_rules_changed", budgetActorChecks(deps.tableName, record.orgId, { developerId: actor.developerId, role: actor.orgRole })) ? "expired" : "retry" };
  const parsed = OwnerFinancialTermsSchema.safeParse(record.ownerFinancialTerms);
  if (!parsed.success || parsed.data.owner !== record.forOwner) throw staleApproval();
  const terms = parsed.data, confirm = record.change?.op === "confirm_move";
  assertOwnerCarriedSource(terms, record.orgId, record);
  const sourceKey = confirm ? undefined : record.chainId !== undefined ? chainKey(record.orgId, record.chainId, "META") : isBuiltinAgentId(record.agentId as never) ? builtinSettingsKey(record.orgId, record.agentId as never) : agentKey(record.orgId, record.agentId as never, "META");
  const source = confirm ? undefined : ApprovalSourceSchema.safeParse(record.approvalSource);
  if (!confirm && (source === undefined || !source.success || source.data.key.pk !== sourceKey?.pk || source.data.key.sk !== sourceKey.sk)) throw staleApproval();
  const keys = [ownerBudgetKey(record.orgId, terms.owner), orgSettingsKey(record.orgId, "SPEND_POLICY"), orgMemberKey(record.orgId, actor.developerId), developerOrgKey(actor.developerId), orgMetaKey(record.orgId), ...(sourceKey === undefined ? [] : [sourceKey])];
  const carried = terms.carriedSource, carrierIndex = keys.length;
  if (carried !== undefined) keys.push(carried.key);
  const response = await deps.documentClient.send(new TransactGetCommand({ TransactItems: keys.map(Key => ({ Get: { TableName: deps.tableName, Key } })) }));
  const snapshot = z.object({ Responses: z.array(z.object({ Item: z.record(z.string(), z.unknown()).optional() })) }).safeParse(response);
  if (!snapshot.success || snapshot.data.Responses.length !== keys.length) throw staleApproval();
  const rows = snapshot.data.Responses.map(row => row.Item), counter = rows[0], member = rows[2], pointer = rows[3], org = rows[4];
  if (member?.orgId !== record.orgId || member.developerId !== actor.developerId || member.role !== actor.orgRole || pointer?.orgId !== record.orgId || pointer.role !== actor.orgRole || org?.orgId !== record.orgId || org.closingAt !== undefined || org.closedAt !== undefined) throw budgetActorRefused();
  const counterVersion = counter?.version === undefined ? 0 : counter.version;
  if (counter === undefined || usdToWholeMicrodollars(counter.totalUsd) === undefined || typeof counterVersion !== "number" || !Number.isSafeInteger(counterVersion) || counterVersion < 0) throw staleApproval();
  const policy = decodeSpendPolicySnapshot(rows[1], org.plan);
  const guards = nativeSnapshotConditions(deps.tableName, keys, rows, ["orgId", "developerId", "role", "closingAt", "closedAt", "plan", "totalUsd", "version", "revision", "ownerAgentBudgetCapUsd", "owner", "accountable", "status", "monthlyBudgetUsd", "maxPerRunUsd", "updatedAt", "updatedBy", "pinnedVersion"]);
  const sourceChanged = !confirm && source?.success === true && (source.data.exists !== (rows[5] !== undefined) || canonicalJson(source.data.fields) !== canonicalJson(sourceFields(rows[5])));
  const currentCarried = carried === undefined ? undefined : rows[carrierIndex];
  const carriedChanged = carried !== undefined && (carried.exists !== (currentCarried !== undefined) || canonicalJson(carried.fields) !== canonicalJson(currentCarried ?? {}));
  const changed = carriedChanged || sourceChanged || terms.month !== iso(deps.now()).slice(0, 7) || terms.counterVersion !== counterVersion || terms.counterUsd !== counter.totalUsd || terms.policyRevision !== policy.revision || terms.capUsd !== policy.policy.ownerAgentBudgetCapUsd;
  if (!changed) return { kind: "retain" };
  return { kind: await expireOne(deps, record, "spending_rules_changed", guards) ? "expired" : "retry" };
}

type SpendingRequestPageInput = { orgId: OrgId; limit: number; cursor?: Record<string, unknown> };
type SpendingRequestPageResult = { examined: number; expired: number; complete: boolean; cursor?: Record<string, unknown> };
export async function expireLegacySpendingRequests(deps: SpendRequestDependencies, input: SpendingRequestPageInput): Promise<SpendingRequestPageResult> {
  return expireSpendingRequestPage(deps, input);
}
/** Explicit bounded task-approval phase. Page exhaustion is not enrollment
 * readiness: owner financial terms and rollout/editing gates remain separate. */
export async function expireUnapprovableTaskStopRequests(deps: SpendRequestDependencies, actor: AgentCaller, input: SpendingRequestPageInput): Promise<SpendingRequestPageResult> {
  if (actor.orgId !== input.orgId || (actor.orgRole !== "owner" && actor.orgRole !== "admin") || await orgRoleOf(deps, actor.orgId, actor.developerId) !== actor.orgRole) throw budgetActorRefused();
  return expireSpendingRequestPage(deps, input, actor);
}
async function expireSpendingRequestPage(deps: SpendRequestDependencies, input: SpendingRequestPageInput, actor?: AgentCaller): Promise<SpendingRequestPageResult> {
  const partition = openSpendRequestsKey(input.orgId, "2000-01-01T00:00:00.000Z", "spr_0").pk;
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > PAGE || (input.cursor !== undefined && (input.cursor.pk !== partition || typeof input.cursor.sk !== "string" || Object.keys(input.cursor).some(key => key !== "pk" && key !== "sk")))) throw agentXError("CONFIG_INVALID", "Invalid spending-request maintenance page.");
  const page = await deps.documentClient.send(new QueryCommand({ TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": partition }, ConsistentRead: true, Limit: input.limit,
    ...(input.cursor === undefined ? {} : { ExclusiveStartKey: input.cursor }) })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
  let expired = 0;
  for (const index of page.Items ?? []) {
    if (index.orgId !== input.orgId || !SpendRequestIdSchema.safeParse(index.spendRequestId).success) throw agentXError("CONFIG_INVALID", "Spending-request index needs repair before cutover.");
    const record = await getSpendRequest(deps, input.orgId, String(index.spendRequestId));
    if (record === undefined || record.status !== "PENDING" || record.kind === "month") continue;
    let completeTerms: boolean;
    if (record.kind === "owner_cap") {
      completeTerms = ownerApprovalTermsComplete(record);
    } else {
      const terms = TaskApprovalTermsSchema.safeParse(record.approvalTerms);
      try { completeTerms = terms.success && taskApprovalRecordMatches(terms.data, record); } catch { completeTerms = false; }
    }
    if (!completeTerms) {
      if (!await expireOne(deps, record, "spending_rules_changed", actor === undefined ? [] : budgetActorChecks(deps.tableName, input.orgId, { developerId: actor.developerId, role: actor.orgRole }))) {
        // Revisit this page after a source race. Earlier expiries are already
        // receipt-backed; advancing past the pending loser would skip it.
        return { examined: (page.Items ?? []).length, expired, complete: false, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) };
      }
      expired += 1;
    } else if (actor !== undefined && record.kind !== "owner_cap") {
      const result = await expireTaskStopCutoverApproval(deps, actor, record.spendRequestId);
      if (result.kind === "retry") return { examined: (page.Items ?? []).length, expired, complete: false, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) };
      if (result.kind === "expired") expired += 1;
    }
  }
  return { examined: (page.Items ?? []).length, expired, complete: page.LastEvaluatedKey === undefined, ...(page.LastEvaluatedKey === undefined ? {} : { cursor: page.LastEvaluatedKey }) };
}

async function expireOne(deps: Pick<SpendRequestDependencies, "documentClient" | "tableName" | "now" | "audit">, record: SpendRequestRecord, because?: SpendRequestRecord["endedBecause"], nativeChecks: TransactItem[] = []): Promise<boolean> {
  const at = iso(deps.now());
  const events = await audited(deps, () => [auditSpendRequestExpired({ orgId: record.orgId, actor: auditActorOf("system"), occurredAt: at, occurrence: record.spendRequestId, ...facts(record) })]);
  const items = endItems(deps, record, { status: "EXPIRED", expiredAt: at, ...(because === undefined ? {} : { endedBecause: because }) });
  // Monthly-room requests retain their existing lifecycle; M47 expires stops
  // and owner-cap terms, and never turns an expiry into an approval.
  if (record.kind !== "month") {
    const source = expirySource(record), update = items[0]?.Update;
    if (update === undefined) throw staleApproval();
    update.ConditionExpression = `(${update.ConditionExpression}) AND (${source.condition})`;
    update.ExpressionAttributeNames = { ...update.ExpressionAttributeNames, ...source.names };
    update.ExpressionAttributeValues = { ...update.ExpressionAttributeValues, ...source.values };
    const Key = spendRequestKey(record.orgId, record.spendRequestId);
    items.push({ Put: { TableName: deps.tableName, Item: { pk: Key.pk, sk: "EXPIRY", entityType: "SPEND_REQUEST_EXPIRY", version: 1,
      orgId: record.orgId, spendRequestId: record.spendRequestId, kind: record.kind, status: "EXPIRED", reason: because ?? "expired",
      actor: { kind: "system" }, occurredAt: at, termsDigest: source.termsDigest }, ConditionExpression: "attribute_not_exists(pk)" } });
  }
  const writes = [...items, ...events.flatMap((event) => auditPending(deps, event))], nativeStart = writes.length;
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [...writes, ...nativeChecks] }));
  } catch (error) {
    const failed = failedIndexes(error);
    if (failed?.has(0) === true || (failed !== undefined && [...failed].some(index => index >= nativeStart))) return false;
    throw error;
  }
  await flushAuditEvents(deps, events);
  await prunePausedTasks(deps, record);
  return true;
}

/** The request's due item moves from where it is to `dueAt`; written with the record's own `dueAt`. */
function moveDueItems(deps: SpendRequestDependencies, record: SpendRequestRecord, dueAt: string): TransactItem[] {
  return [
    { Delete: { TableName: deps.tableName, Key: dueKeyOf(record) } },
    { Put: { TableName: deps.tableName, Item: dueItem(record, dueAt) } },
  ];
}

/** A request that will not escalate is next due at its expiry. */
async function dueAtExpiry(deps: SpendRequestDependencies, record: SpendRequestRecord): Promise<void> {
  if ((record.dueAt ?? record.createdAt) === record.expiresAt) return;
  await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
    {
      Update: {
        TableName: deps.tableName, Key: spendRequestKey(record.orgId, record.spendRequestId), UpdateExpression: "SET dueAt = :due",
        ConditionExpression: "#status = :pending", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":due": record.expiresAt, ":pending": "PENDING" },
      },
    },
    ...moveDueItems(deps, record, record.expiresAt),
  ] })).catch((error: unknown) => {
    if (failedIndexes(error)?.has(0) !== true) throw error;
  });
}

async function escalateOne(deps: SpendRequestDependencies, record: SpendRequestRecord): Promise<boolean> {
  const at = iso(deps.now());
  const ids = (await spendApprovers(deps, { ...record, escalatedAt: at })).ids;
  const events = await audited(deps, () => [auditSpendRequestEscalated({ orgId: record.orgId, actor: auditActorOf("system"), occurredAt: at, occurrence: record.spendRequestId, ...facts(record) })]);
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      {
        Update: {
          TableName: deps.tableName, Key: spendRequestKey(record.orgId, record.spendRequestId), UpdateExpression: "SET escalatedAt = :at, approverIds = :ids, dueAt = :due",
          ConditionExpression: "#status = :pending AND attribute_not_exists(escalatedAt)", ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":at": at, ":ids": ids, ":due": record.expiresAt, ":pending": "PENDING" },
        },
      },
      { Put: { TableName: deps.tableName, Item: { ...openSpendRequestsKey(record.orgId, record.createdAt, record.spendRequestId), entityType: "SPEND_REQUEST_OPEN", orgId: record.orgId, spendRequestId: record.spendRequestId, approverIds: ids } } },
      ...moveDueItems(deps, record, record.expiresAt),
      ...events.flatMap((event) => auditPending(deps, event)),
    ] }));
  } catch (error) {
    if (failedIndexes(error)?.has(0) === true) return false;
    throw error;
  }
  await flushAuditEvents(deps, events);
  return true;
}

// ---- withdrawing a request the task went on without (fix round 1, I-3)

const REQUEST_KIND_OF_PAUSE: Partial<Record<PauseScope["kind"], SpendRequestKind>> = { task: "run_limit", max_per_run: "max_per_run", planning: "planning" };

/**
 * The open request of the pause a person's Continue removes, ended (EXPIRED, `continued`) in the Continue's own transaction: the items to write with it and
 * the audit to flush once it committed. Nothing for a task with no such request.
 */
export async function withdrawTaskSpendRequests(deps: SpendRequestDependencies, task: Pick<DeveloperTaskRecord, "orgId" | "taskId" | "budgetPause">): Promise<{ items: TransactItem[]; flush: () => Promise<void> }> {
  const kind = task.budgetPause === undefined ? undefined : REQUEST_KIND_OF_PAUSE[task.budgetPause.scope.kind];
  const record = kind === undefined || task.orgId === undefined ? undefined : await openRequestFor(deps, task.orgId, `TASK#${task.taskId}`, kind);
  if (record === undefined) return { items: [], flush: () => Promise.resolve() };
  const at = iso(deps.now());
  const events = await audited(deps, () => [auditSpendRequestExpired({ orgId: record.orgId, actor: auditActorOf("system"), occurredAt: at, occurrence: record.spendRequestId, ...facts(record) })]);
  return {
    items: [...endItems(deps, record, { status: "EXPIRED", expiredAt: at, endedBecause: "continued" }), ...events.flatMap((event) => auditPending(deps, event))],
    flush: () => flushAuditEvents(deps, events),
  };
}

/**
 * Final fix wave (runs I-3, money I-1; owner decision 2 = A): whether `caller` may go on with a task that is paused on a run limit, a planning limit or its
 * agent's max per run, by a Continue, a workflow retry or a send-back, which start a new window of the cap and so skip the approval the pause asked for. Only a
 * person who may decide that request themselves (`mayDecideNow`: the open request, else the request the pause would ask for, routed as `requestForPausedTask`
 * routes it) may; anyone else is told who is asked. A max per run holds for every task; a run limit or planning limit holds for a run with an agent (a plain
 * Rovara Code task keeps R38). A pause that is a month's budget, a test's cap or a run held at its start is not a window: nothing here.
 */
export async function pausedTaskGate(
  deps: SpendRequestDependencies, caller: Pick<AgentCaller, "orgId" | "developerId">, task: Pick<DeveloperTaskRecord, "orgId" | "taskId" | "budgetPause" | "agent" | "budgetUsd" | "maxPerRunUsd" | "startedBy" | "developerId" | "payer"> & TaskOwnerSource,
): Promise<{ allowed: true } | { allowed: false; who: string }> {
  const pause = task.budgetPause;
  const kind = pause === undefined || pause.firstDispatch !== undefined ? undefined : REQUEST_KIND_OF_PAUSE[pause.scope.kind];
  if (pause === undefined || kind === undefined || task.orgId === undefined) return { allowed: true };
  const withAgent = !isRovaraCodeTask(task);
  if (kind !== "max_per_run" && !withAgent) return { allowed: true };
  const orgId = task.orgId;
  const open = await openRequestFor(deps, orgId, `TASK#${task.taskId}`, kind);
  let record = open !== undefined && Date.parse(open.expiresAt) > deps.now() ? open : undefined;
  if (record === undefined) {
    // Nothing is open (denied, expired, or never asked): the request that would be asked now decides who may go on.
    const limit = runLimitOf(task as DeveloperTaskRecord);
    const max = task.maxPerRunUsd ?? limit;
    const amountUsd = suggestedTopUpUsd(kind === "max_per_run" ? max : limit);
    const newLimitUsd = kind === "max_per_run" ? cleanUsd(max + amountUsd) : kind === "planning" ? amountUsd : cleanUsd(limit + amountUsd);
    record = {
      orgId, kind, scope: pause.scope, taskId: task.taskId, amountUsd, newLimitUsd, requestedBy: { kind: "system" }, requestedFor: { developerId: isTaskTakenOver(task) ? effectiveTaskOwner(task).developerId : task.startedBy?.developerId ?? effectiveTaskOwner(task).developerId },
    } as SpendRequestRecord;
  }
  const may = await mayDecideNow(deps, caller, record);
  return may.allowed ? { allowed: true } : { allowed: false, who: may.who };
}

// ---- the member movers (PF14)

/** The stored change with `from` read as `to` (a merge), or undefined when it does not name `from`. */
function movedChange(change: OwnerCapChange | undefined, from: string, to: string): OwnerCapChange | undefined {
  if (change === undefined) return undefined;
  switch (change.op) {
    case "set_owner": {
      const owner = change.owner.kind === "member" && change.owner.developerId === from ? { kind: "member" as const, developerId: to } : change.owner;
      const accountable = change.accountable?.developerId === from ? { developerId: to } : change.accountable;
      return owner === change.owner && accountable === change.accountable ? undefined : { op: "set_owner", owner, ...(accountable === undefined ? {} : { accountable }) };
    }
    case "set_accountable": return change.accountable.developerId === from ? { op: "set_accountable", accountable: { developerId: to } } : undefined;
    case "confirm_move": return change.owner === from ? { ...change, owner: to } : undefined;
    default: return undefined;
  }
}

/** Moves one open request's mentions of `from` to `to`: conditional on it being PENDING and unmoved since it was read, audited as the system's. */
async function moveOne(deps: LifecycleDeps, record: SpendRequestRecord, from: string, to: string, mode: "merged" | "removed"): Promise<void> {
  const stored = await getItem(deps, spendRequestKey(record.orgId, record.spendRequestId));
  const revision = typeof stored?.["moveRevision"] === "number" ? stored["moveRevision"] : 0;
  const ids = [...new Set(record.approverIds.map((id) => (id === from ? to : id)))].sort();
  const requestedBy = record.requestedBy.kind === "member" && record.requestedBy.developerId === from ? { kind: "member" as const, developerId: to } : record.requestedBy;
  const newOwner = record.newOwner?.developerId === from ? { developerId: to } : record.newOwner;
  // A merge: the person the change names is the survivor now (a removal ends such a request instead, `moveRequests`).
  const change = mode === "merged" ? movedChange(record.change, from, to) : undefined;
  // The person an `owner_cap` request was summed against is the survivor too (M-3); on a removal it stays, and an approval then finds the agent counted for someone else.
  const forOwner = mode === "merged" && record.forOwner === from ? to : undefined;
  const at = iso(deps.now());
  const events = await tryAuditEvents(deps, () => [auditSpendRequestRerouted({
    orgId: record.orgId, actor: auditActorOf("system"), occurredAt: at, occurrence: auditOccurrence(record.spendRequestId, String(revision + 1)), spendRequestId: record.spendRequestId, kind: record.kind, mode, from, to,
  })]);
  await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
    {
      Update: {
        TableName: deps.tableName, Key: spendRequestKey(record.orgId, record.spendRequestId),
        UpdateExpression: `SET approverIds = :ids, requestedBy = :by, movedBy = :system, movedAt = :at, moveRevision = :next${newOwner === undefined ? "" : ", newOwner = :owner"}${change === undefined ? "" : ", #change = :change"}${forOwner === undefined ? "" : ", forOwner = :forOwner"}`,
        ConditionExpression: revision === 0 ? "#status = :pending AND attribute_not_exists(moveRevision)" : "#status = :pending AND moveRevision = :seen",
        ExpressionAttributeNames: { "#status": "status", ...(change === undefined ? {} : { "#change": "change" }) },
        ExpressionAttributeValues: {
          ":ids": ids, ":by": requestedBy, ":system": "system", ":at": at, ":next": revision + 1, ":pending": "PENDING",
          ...(newOwner === undefined ? {} : { ":owner": newOwner }), ...(change === undefined ? {} : { ":change": change }), ...(forOwner === undefined ? {} : { ":forOwner": forOwner }), ...(revision === 0 ? {} : { ":seen": revision }),
        },
      },
    },
    { Put: { TableName: deps.tableName, Item: { ...openSpendRequestsKey(record.orgId, record.createdAt, record.spendRequestId), entityType: "SPEND_REQUEST_OPEN", orgId: record.orgId, spendRequestId: record.spendRequestId, approverIds: ids } } },
    ...events.flatMap((event) => auditPending(deps, event)),
  ] }));
  await flushAuditEvents(deps, events);
}

/**
 * Every open request of the org that names `from` (as an approver, the asker or the new owner) is handed to `to`. An `owner_cap` change that names `from` is
 * rewritten to `to` on a merge, and ends the request on a removal (fix round 1, I-1): the change was asked for that person. Repeatable; time-bound by `checkTime`.
 */
async function moveRequests(deps: LifecycleDeps, orgId: OrgId, from: string, to: string, mode: "merged" | "removed"): Promise<void> {
  const open = await queryAll(deps, openSpendRequestsKey(orgId, "2000-01-01T00:00:00.000Z", "spr_0").pk);
  for (const item of open) {
    const ids = item["approverIds"];
    const id = item["spendRequestId"];
    if (typeof id !== "string") continue;
    checkTime(deps);
    const record = await getSpendRequest(deps, orgId, id);
    if (record === undefined || record.status !== "PENDING") continue;
    const named = movedChange(record.change, from, to) !== undefined;
    if (named && mode === "removed") {
      await expireOne(deps, record, "target_left");
      continue;
    }
    const names = named || record.approverIds.includes(from) || (record.requestedBy.kind === "member" && record.requestedBy.developerId === from) || record.newOwner?.developerId === from || (mode === "merged" && record.forOwner === from);
    if (!names && !(Array.isArray(ids) && ids.includes(from))) continue;
    for (let tried = 0; ; tried += 1) {
      try {
        await moveOne(deps, (await getSpendRequest(deps, orgId, id)) ?? record, from, to, mode);
        // A removal may leave a request no one can decide (the successor is the person who asked, or is no approver): it is settled on who may decide it now (Re-check R-1).
        if (mode === "removed") await settleAfterLeave(deps, orgId, id, from);
        break;
      } catch (error) {
        if (failedIndexes(error) === undefined || tried >= 2) throw error;
        const again = await getSpendRequest(deps, orgId, id);
        if (again === undefined || again.status !== "PENDING") break;
      }
    }
  }
}

/**
 * A request that named a person who left (Plan 5 Task 21, review M-5 and Re-check R-1): who may decide is read live (`spendApprovers`, then `mayDecideNow`, which keeps the person who
 * asked from deciding their own), so the approvers listed are the ones who can decide it now, whether an owner is left or not. When no one can, the request ends (`approver_left`, with the words
 * the asker reads) and the asker is told with a `home.changed` change notice (ids only). It is never approved. Conditional on the request still being PENDING and listing the same
 * approvers; repeatable.
 */
async function settleAfterLeave(deps: LifecycleDeps, orgId: OrgId, id: string, from: string): Promise<void> {
  const full = deps as unknown as SpendRequestDependencies;
  for (let tried = 0; tried < 3; tried += 1) {
    const record = await getSpendRequest(deps, orgId, id);
    if (record === undefined || record.status !== "PENDING") return;
    const deciders: string[] = [];
    for (const approver of (await spendApprovers(full, record)).ids.slice(0, 20)) {
      if (approver !== from && (await mayDecideNow(full, { orgId, developerId: approver }, record)).allowed) deciders.push(approver);
    }
    deciders.sort();
    if (deciders.length === 0) {
      if (await expireOne(deps, record, "approver_left")) {
        const task = await readTask(deps, orgId, record.taskId);
        const asker = record.requestedBy.kind === "member" ? record.requestedBy.developerId : task === undefined ? undefined : tryEffectiveTaskOwner(task)?.developerId;
        if (asker !== undefined && asker !== from) {
          await writeChanges({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, orgId, [{ developerId: asker, notice: { type: "home.changed", revision: 0 }, at: iso(deps.now()) }]);
        }
        return;
      }
      continue;
    }
    if (JSON.stringify([...record.approverIds].sort()) === JSON.stringify(deciders)) return;
    const at = iso(deps.now());
    const events = await tryAuditEvents(deps, () => [auditSpendRequestRerouted({
      orgId, actor: auditActorOf("system"), occurredAt: at, occurrence: auditOccurrence(id, "orphaned", at), spendRequestId: id, kind: record.kind, mode: "removed", from, to: deciders[0]!,
    })]);
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
        {
          Update: {
            TableName: deps.tableName, Key: spendRequestKey(orgId, id), UpdateExpression: "SET approverIds = :rest, movedBy = :system, movedAt = :at",
            ConditionExpression: "#status = :pending AND approverIds = :seen", ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":rest": deciders, ":seen": record.approverIds, ":pending": "PENDING", ":system": "system", ":at": at },
          },
        },
        { Put: { TableName: deps.tableName, Item: { ...openSpendRequestsKey(orgId, record.createdAt, id), entityType: "SPEND_REQUEST_OPEN", orgId, spendRequestId: id, approverIds: deciders } } },
        ...events.flatMap((event) => auditPending(deps, event)),
      ] }));
      await flushAuditEvents(deps, events);
      return;
    } catch (error) {
      if (failedIndexes(error) === undefined || tried >= 2) throw error;
    }
  }
}

/** `from` left an org that has no owner to hand anything to: every open request that lists them is settled (see `settleAfterLeave`). */
async function orphanRequests(deps: LifecycleDeps, orgId: OrgId, from: string): Promise<void> {
  const open = await queryAll(deps, openSpendRequestsKey(orgId, "2000-01-01T00:00:00.000Z", "spr_0").pk);
  for (const item of open) {
    const id = item["spendRequestId"];
    if (typeof id !== "string") continue;
    checkTime(deps);
    const record = await getSpendRequest(deps, orgId, id);
    if (record === undefined || record.status !== "PENDING" || !record.approverIds.includes(from)) continue;
    await settleAfterLeave(deps, orgId, id, from);
  }
}

registerOwnerCapConfirmation((deps, orgId, owner, cause, totals) => confirmOwnerMove(deps as SpendRequestDependencies, orgId, owner, cause, totals));

registerMemberMover({
  name: "spend-requests",
  merged: (deps, { orgId, survivorId, duplicateId }) => moveRequests(deps, orgId, duplicateId, survivorId, "merged"),
  removed: (deps, { orgId, developerId, successorId }) => moveRequests(deps, orgId, developerId, successorId, "removed"),
  orphaned: (deps, { orgId, developerId }) => orphanRequests(deps, orgId, developerId),
});

// ---- the confirmation page's kind (PF21)

/** A decision's request id from its session: one session decides one request, so the same session always names the same request (R18). */
function requestIdFor(proof: AuditProof, spendRequestId: string): string {
  const hex = createHash("sha256").update(`rovara-page-spend-decision|${proof.kind === "fresh_sign_in" ? proof.sessionRef : ""}|${spendRequestId}`).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = "89ab"[Number.parseInt(hex[16]!, 16) % 4]!;
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

const fact = (label: string, value: string) => ({ label, value });
const KIND_TITLES: Record<SpendRequestKind, string> = {
  run_limit: "A task needs more AI budget",
  max_per_run: "A run reached its agent's max per run",
  planning: "Planning needs more AI budget",
  month: "A monthly AI budget ran out",
  owner_cap: "An agent budget change is over the limit for one person",
};

/** The page's view of an open request: who pays, what it raises, how much, the new limit, and why. */
async function confirmViewOf(deps: SpendRequestDependencies, record: SpendRequestRecord): Promise<ConfirmView> {
  const facts_: Array<{ label: string; value: string }> = [];
  const task = await readTask(deps, record.orgId, record.taskId);
  if (task !== undefined) {
    const payer = task.payer ?? { kind: "member" as const, developerId: task.developerId };
    facts_.push(fact("Payer", payer.kind === "member" ? await nameOf(deps, payer.developerId) : payer.kind === "project" ? `the ${payer.project} project` : payer.kind === "chain" ? "the chain's budget" : "the agent's budget"));
    facts_.push(fact("Project", task.place?.project ?? task.project), fact("Task", task.title ?? task.taskId));
    if (task.agent !== undefined) facts_.push(fact("Agent", task.agent.name));
  }
  if (record.agentId !== undefined) {
    const agent = await deps.store.get(record.orgId, record.agentId as never).catch(() => undefined);
    if (agent !== undefined) facts_.push(fact("Agent", agent.name));
  }
  const chainId = record.chainId ?? (record.scope?.kind === "chain" ? record.scope.chainId : undefined);
  if (chainId !== undefined) {
    const chain = await deps.chains?.get(record.orgId, chainId).catch(() => undefined);
    if (chain !== undefined) facts_.push(fact("Chain", chain.name));
  }
  const scopeWords = record.kind === "max_per_run" ? "This run's max per run" : record.kind === "planning" ? "This task's planning limit" : record.kind === "run_limit" ? "This task's run limit"
    : record.kind === "owner_cap" ? (record.chainId === undefined ? "One person's agent budgets" : "One person's agent and chain budgets") : "A monthly budget";
  facts_.push(fact("Raises", scopeWords), fact("Amount", dollars(record.amountUsd)));
  if (record.newLimitUsd !== undefined) facts_.push(fact("New limit", dollars(record.newLimitUsd)));
  facts_.push(fact("Expires", record.expiresAt));
  const title = record.kind === "owner_cap" && record.chainId !== undefined ? "A chain budget change is over the limit for one person" : KIND_TITLES[record.kind];
  return { title, facts: facts_, paragraphs: [record.reason] };
}

/** The `spr` kind of the confirmation page (PF21): `inspect` is the same live evaluation `decideSpendRequest` makes; `decide` is that function as the member. */
export function spendDecideKind(deps: SpendRequestDependencies): DecideKind {
  async function callerOf(target: DecideTarget, proof?: AuditProof): Promise<AgentCaller | undefined> {
    const orgRole = await orgRoleOf(deps, target.orgId, target.developerId);
    return orgRole === undefined ? undefined : { orgId: target.orgId, developerId: target.developerId, orgRole, ...(proof === undefined ? {} : { decideProof: proof }) };
  }
  async function inspect(target: DecideTarget): Promise<DecideInspection> {
    const caller = await callerOf(target);
    if (caller === undefined) return { status: "not_found" };
    const record = await getSpendRequest(deps, target.orgId, target.approvalId);
    if (record === undefined) return { status: "not_found" };
    const may = await mayDecideNow(deps, caller, record);
    if (!may.allowed) return { status: "forbidden", who: may.who };
    if (record.status === "EXPIRED") return { status: "expired", at: record.expiresAt };
    if (record.status !== "PENDING") return { status: "decided", by: await nameOf(deps, record.decidedBy), at: record.decidedAt ?? record.expiresAt };
    if (Date.parse(record.expiresAt) <= deps.now()) return { status: "expired", at: record.expiresAt };
    return { status: "open", view: await confirmViewOf(deps, record) };
  }
  async function decide(target: DecideTarget, decision: "approve" | "decline", proof: AuditProof): Promise<DecideOutcome> {
    if (proof.kind !== "fresh_sign_in") throw agentXError("FORBIDDEN", "Decisions are made on the confirmation page. Open the request again from Rovara.");
    const caller = await callerOf(target, proof);
    if (caller === undefined) throw notFound();
    const { spendRequest } = await decideSpendRequest(deps, caller, target.approvalId, { requestId: requestIdFor(proof, target.approvalId), decision: decision === "approve" ? "APPROVE" : "DENY" });
    return { message: spendRequest["status"] === "APPROVED" ? "Approved. The new limit applies now." : "Declined. Nothing was changed." };
  }
  return { inspect, decide };
}

// ---- a member asks for a month (Task 33)

const Hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const BudgetScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("org") }).strict(),
  z.object({ kind: z.literal("member"), developerId: Hex64 }).strict(),
  z.object({ kind: z.literal("project"), project: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal("agent"), agentId: AgentIdSchema }).strict(),
  z.object({ kind: z.literal("chain"), chainId: ChainIdSchema }).strict(),
  z.object({ kind: z.literal("testing"), developerId: Hex64 }).strict(),
]);
const AskMonthBodySchema = z.object({
  requestId: z.string().uuid(),
  kind: z.literal("month"),
  scope: BudgetScopeSchema,
  amountUsd: z.number().finite().positive().max(1_000_000),
  reason: z.string().trim().min(1).max(1_000),
}).strict();

/** The caller asks for a scope they pay from or work in: their own month or testing allowance, a project they have a role on, an agent they may use, the org. */
async function requireMayAsk(deps: SpendRequestDependencies, caller: AgentCaller, scope: BudgetScope): Promise<void> {
  switch (scope.kind) {
    case "member":
    case "testing":
      if (await resolveSurvivor(deps, caller.orgId, scope.developerId) !== await resolveSurvivor(deps, caller.orgId, caller.developerId)) {
        throw agentXError("FORBIDDEN", "You can ask for more of your own monthly budget only.");
      }
      return;
    case "project": await roleOnProject(deps, caller, scope.project); return;
    case "agent": await requireAgentAccess(deps, caller, scope.agentId, "use"); return;
    case "chain":
      if (deps.chains === undefined) throw notFound();
      await requireChainAccess({ ...deps, store: deps.chains }, caller, scope.chainId, "use");
      return;
    case "org": return;
  }
}

/**
 * `POST /v1/app/spend-requests` [member]: `{ requestId, kind: "month", scope, amountUsd, reason }`. One PENDING per month, scope and requester: asking again
 * answers the open one (with `differs: true` when the figures asked for now are not the open one's, which keeps its own). R18: a repeat of the request
 * answers what it first did. A scope with no limit can't be topped up (R47). The asker is who the request is for (`requestedFor`): they may not decide it
 * unless they are the org's only owner or admin (fix round 1, I-3). A member or testing scope named by a merged-away id is the survivor's (M-7).
 */
async function askForMonth(deps: SpendRequestDependencies, caller: AgentCaller, value: unknown): Promise<StatusReply> {
  const parsed = AskMonthBodySchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "is not valid"}`);
  }
  const body = parsed.data;
  await requireMayAsk(deps, caller, body.scope);
  const scope: BudgetScope = body.scope.kind === "member" || body.scope.kind === "testing"
    ? { kind: body.scope.kind, developerId: await resolveSurvivor(deps, caller.orgId, body.scope.developerId) } : body.scope;
  const mark: RequestMark = {
    orgId: caller.orgId, developerId: caller.developerId, requestId: body.requestId,
    fingerprint: createHash("sha256").update(JSON.stringify(["spend-ask-month", scopeKey(scope), body.amountUsd, body.reason])).digest("hex"),
  };
  const earlier = await readRequest(deps, caller.orgId, caller.developerId, body.requestId);
  if (earlier !== undefined) {
    if (earlier.fingerprint !== mark.fingerprint) throw agentXError("CONFIG_INVALID", "requestId: this request ID was already used for a different request");
    // An ask that found a request open answered 200 (M-1): its repeat does too, without the note that says so.
    const { answeredOpen, ...answer } = earlier.result as { answeredOpen?: boolean } & Record<string, unknown>;
    return new StatusReply(answeredOpen === true ? 200 : 201, answeredOpen === true ? answer : earlier.result as object);
  }
  const month = iso(deps.now()).slice(0, 7);
  const limit = (await effectiveLimits(deps, { orgId: caller.orgId, month, scopes: [scope] })).get(scopeKey(scope));
  if (limit === undefined) {
    // Whether the org has a limit is the admins' to know (M-8).
    throw agentXError("CONFIG_INVALID", scope.kind === "org" && !isOrgAdminRole(caller) ? "scope: you can't ask for more of that budget" : "scope: that budget has no monthly limit to raise");
  }
  const me = await resolveSurvivor(deps, caller.orgId, caller.developerId);
  const made = await createSpendRequest(deps, {
    orgId: caller.orgId, kind: "month", scope, subject: monthSubject(month, scope, me), amountUsd: body.amountUsd, newLimitUsd: cleanUsd(limit + body.amountUsd),
    requestedBy: { kind: "member", developerId: me }, requestedFor: { developerId: me }, reason: body.reason, request: mark,
    requestResult: (record) => ({ spendRequest: spendRequestView(deps, record, caller) }),
  });
  if (made.created) return new StatusReply(201, { spendRequest: spendRequestView(deps, made.record, caller) });
  const differs = made.record.amountUsd !== cleanUsd(body.amountUsd) || made.record.reason !== cleanReason(body.reason);
  const answer = { spendRequest: spendRequestView(deps, made.record, caller), ...(differs ? { differs: true } : {}) };
  // The ask that found a request open wrote no mark with it (M-1): the answer is remembered here, so a repeat after the request is decided answers the same and
  // does not make a new one. A mark that is already there (the same id sent twice at once) is that ask's own.
  await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [requestMarkItem(deps, mark, { ...answer, answeredOpen: true })] })).catch((error: unknown) => {
    if (failedIndexes(error)?.has(0) !== true) throw error;
  });
  return new StatusReply(200, answer);
}

// ---- the routes

const SPEND_REQUESTS_PATH = /^\/v1\/app\/spend-requests(?:\/([^/]+)(?:\/(decide|confirm-link))?)?$/;
const CONTINUE_AS_TASK_PATH = /^\/v1\/app\/tasks\/([^/]+)\/continue-as-task$/;
/** A task ID from a path segment; a malformed percent-encoding is a task that does not exist, not a server error. */
function taskIdOfPath(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw agentXError("TASK_NOT_FOUND", "that task doesn't exist");
  }
}
const RUN_LIMIT_REQUEST_PATH = /^\/v1\/app\/tasks\/([^/]+)\/run-limit-request$/;

export const isSpendRequestRoute = (pathname: string): boolean => SPEND_REQUESTS_PATH.test(pathname) || CONTINUE_AS_TASK_PATH.test(pathname) || RUN_LIMIT_REQUEST_PATH.test(pathname);

function jsonBody(request: Pick<AdaptedHttpRequest, "body">): unknown {
  if (request.body === undefined || request.body === "") return {};
  try {
    return JSON.parse(request.body) as unknown;
  } catch {
    throw agentXError("CONFIG_INVALID", "the request body is not JSON");
  }
}

/** Whether `caller` may look at a request: they may decide it now, or they asked for it, or it is about a task of theirs. */
async function maySee(deps: SpendRequestDependencies, caller: AgentCaller, record: SpendRequestRecord): Promise<boolean> {
  if ((await mayDecideNow(deps, caller, record)).allowed) return true;
  const me = await resolveSurvivor(deps, caller.orgId, caller.developerId);
  if (record.requestedBy.kind === "member" && await resolveSurvivor(deps, caller.orgId, record.requestedBy.developerId) === me) return true;
  const task = await readTask(deps, record.orgId, record.taskId);
  const owner = task === undefined ? undefined : tryEffectiveTaskOwner(task);
  return owner !== undefined && await resolveSurvivor(deps, caller.orgId, owner.developerId) === me;
}

/**
 * The spend request routes:
 *   GET  /v1/app/spend-requests                   the open requests the caller may decide now
 *   GET  /v1/app/spend-requests/{id}               one request, to someone who may decide it, asked for it, or whose task it is (404 to anyone else)
 *   POST /v1/app/spend-requests/{id}/decide        through `requireDecide` only (R66): a token gets REAUTH_REQUIRED with the page's link
 *   POST /v1/app/spend-requests/{id}/confirm-link  the ticketed link for a person who may decide it now
 *   POST /v1/app/tasks/{id}/continue-as-task       [the task's owner] a test run that reached its cap goes on as a normal task
 *   POST /v1/app/tasks/{id}/run-limit-request      [the task's owner] ask again for a blocked plan's run limit, or for a paused or held run's limit, once the last request was denied or ran out
 */
export async function routeSpendRequests(deps: SpendRequestDependencies, caller: AgentCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const continued = CONTINUE_AS_TASK_PATH.exec(url.pathname);
  if (continued !== null) {
    if (request.method !== "POST") throw agentXError("NOT_FOUND", "route not found");
    if (deps.spendRequests?.continueAsTask === undefined) throw agentXError("NOT_FOUND", "that isn't available yet");
    // Rovara Code (Plan 6): a client that does not send `x-agentx-task-view: 2` reads a version 1 projection of the task.
    return taskResponseForClient(await deps.spendRequests.continueAsTask(caller, taskIdOfPath(continued[1]!), jsonBody(request)), request.headers);
  }
  const asked = RUN_LIMIT_REQUEST_PATH.exec(url.pathname);
  if (asked !== null) {
    if (request.method !== "POST") throw agentXError("NOT_FOUND", "route not found");
    return askRunLimitAgain(deps, caller, taskIdOfPath(asked[1]!), jsonBody(request));
  }
  const matched = SPEND_REQUESTS_PATH.exec(url.pathname);
  if (matched === null) throw agentXError("NOT_FOUND", "route not found");
  const [, rawId, action] = matched;
  if (rawId === undefined) {
    if (request.method === "POST") return askForMonth(deps, caller, jsonBody(request));
    if (request.method !== "GET") throw agentXError("NOT_FOUND", "route not found");
    if ((url.searchParams.get("status") ?? "PENDING") !== "PENDING") throw agentXError("CONFIG_INVALID", "status: PENDING is the only list");
    const open = await queryAll(deps, openSpendRequestsKey(caller.orgId, "2000-01-01T00:00:00.000Z", "spr_0").pk, undefined, LIST_MAX);
    const me = await resolveSurvivor(deps, caller.orgId, caller.developerId);
    const shown: Array<Record<string, unknown>> = [];
    for (const item of open.slice(0, LIST_MAX)) {
      const record = typeof item["spendRequestId"] === "string" ? await getSpendRequest(deps, caller.orgId, item["spendRequestId"]) : undefined;
      if (record?.status !== "PENDING" || Date.parse(record.expiresAt) <= deps.now()) continue;
      // Those the caller may decide now, and their own.
      const mine = record.requestedBy.kind === "member" && await resolveSurvivor(deps, caller.orgId, record.requestedBy.developerId) === me;
      if (mine || (await mayDecideNow(deps, caller, record)).allowed) shown.push(spendRequestView(deps, record, caller));
    }
    return { spendRequests: shown };
  }
  const visible = async (): Promise<SpendRequestRecord> => {
    const record = await getSpendRequest(deps, caller.orgId, rawId);
    if (record === undefined || !await maySee(deps, caller, record)) throw notFound();
    return record;
  };
  if (action === undefined) {
    if (request.method !== "GET") throw agentXError("NOT_FOUND", "route not found");
    return { spendRequest: spendRequestView(deps, await visible(), caller) };
  }
  if (request.method !== "POST") throw agentXError("NOT_FOUND", "route not found");
  if (action === "confirm-link") {
    const record = await visible();
    const bare = { confirmUrl: `${deps.confirmOrigin}/v1/app/approve/${record.spendRequestId}`, ticketed: false };
    if (deps.mintConfirmUrl === undefined || record.status !== "PENDING" || Date.parse(record.expiresAt) <= deps.now() || !(await mayDecideNow(deps, caller, record)).allowed) return bare;
    try {
      return { confirmUrl: await deps.mintConfirmUrl(caller, record.spendRequestId), ticketed: true };
    } catch (error) {
      if (error instanceof AgentXError) return bare;
      throw error;
    }
  }
  const requireDecide = deps.requireDecide;
  if (requireDecide === undefined) throw agentXError("NOT_FOUND", "that isn't available yet");
  const { csrf: _csrf, ...given } = jsonBody(request) as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unused-vars -- checked by the guard
  const authority = await requireDecide(request, rawId);
  let end: DecisionEnd = "refused";
  try {
    const orgRole = await orgRoleOf(deps, authority.orgId, authority.developerId);
    if (orgRole === undefined) throw notFound();
    const decider: AgentCaller = { orgId: authority.orgId, developerId: authority.developerId, orgRole, decideProof: authority.proof };
    const body = authority.proof.kind === "fresh_sign_in" ? { ...given, requestId: requestIdFor(authority.proof, rawId) } : given;
    if (await getSpendRequest(deps, decider.orgId, rawId) === undefined) throw notFound();
    end = "failed";
    const result = await decideSpendRequest(deps, decider, rawId, body);
    end = "decided";
    return result;
  } catch (error) {
    if (end === "failed") end = endOfFailure(error);
    throw error;
  } finally {
    await settleSession(authority, end);
  }
}
