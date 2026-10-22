// Plan 3 Task 32: requests for more spend. A run that reached one of its own limits (its run limit, the agent's max per run, the planning limit) asks the person
// who may raise it; an agent budget change that would take one person past the owner cap asks an org admin. A request is one record (`spendRequestKey`) with
// the org's open index item, a global due item for the settlement run, and a slot per subject and kind, so a second pause asks for nothing new. Who may decide
// is read live (`spendApprovers`, R68), never from the stored list, which is kept for the lists and the movers. Deciding goes only through the confirmation
// page (Task 21a's `requireDecideSession`, R66); an approval changes the limit in the same transaction that ends the request, and then the task goes on where
// it stopped (`SpendRequestHost.resumeTask`, which is `resumeTaskAfterSpendApproval` in developer-tasks.ts).
import { createHash } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  AgentIdSchema, AgentXError, PER_TASK_BUDGET_USD, SPEND_REQUEST_REASON_MAX, SPEND_REQUEST_TTL_DAYS, OWNER_ANSWER_HOURS, SpendRequestIdSchema, agentXError, isBuiltinAgentId,
  newPrefixedId, openSpendRequestDueKey, openSpendRequestsKey, orgPk, ownerBudgetKey, pauseKey, pausedTasksKey, scopeKey, spendRequestKey, spendRequestSlotKey,
  suggestedMonthTopUpUsd, suggestedTopUpUsd, topUpKey,
  type AuditEventInput, type AuditProof, type BudgetScope, type OrgId, type OwnerCapChange, type PauseScope, type SpendApproverRole, type SpendRequestKind, type SpendRequestRecord,
} from "@agentx/contracts";
import { orgRoleOf, requireAgentAccess, resolveSurvivor, type AgentCaller } from "../agents/access.js";
import { roleOnProject } from "../agents/roster.js";
import { StatusReply } from "../aws/status-reply.js";
import { budgetOwnerOf, ownerVersionItem } from "./owner-total.js";
import { readGuardrails } from "../agents/guardrails.js";
import { checkTime, registerMemberMover, registerOwnerCapConfirmation, type LifecycleDeps } from "../agents/lifecycle.js";
import type { AgentRouteDependencies } from "../agents/routes.js";
import { failedIndexes, readRequest, requestMarkItem, type RequestMark, type TransactItem } from "../agents/table-writes.js";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { auditSpendRequestCreated, auditSpendRequestDecided, auditSpendRequestEscalated, auditSpendRequestExpired, auditSpendRequestRerouted, auditOccurrence } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents } from "../audit/outbox.js";
import { auditActorOf, centsOf, decisionProofOf } from "../audit/plan3-hooks.js";
import type { ConfirmView, DecideInspection, DecideKind, DecideOutcome, DecideTarget } from "../developer/decide-kinds.js";
import { endOfFailure, settleSession, type DecisionEnd } from "../developer/decide-session.js";
import { taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { effectiveLimits, readSpendPolicy } from "./settings.js";
import { cleanUsd, readTopUp } from "./top-ups.js";

/** What the broker does for a request once it is approved: the parts that live with the developer tasks. */
export interface SpendRequestHost {
  /** Goes on with a task whose limit was raised (`resumeTaskAfterSpendApproval` in developer-tasks.ts). Never asked for a task in another org. */
  resumeTask(input: { orgId: OrgId; taskId: string; spendRequestId: string; resetRunWindow: boolean; firstDispatch: boolean }): Promise<void>;
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
  /** A `month` request routed to an agent's owner: whose total it was summed in and the owner counter's `version` it was summed at (R4-6). */
  owner?: { developerId: string; version: number };
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
const closed = (record: Pick<SpendRequestRecord, "status">) =>
  agentXError("APPROVAL_CLOSED", record.status === "EXPIRED" ? "This request expired, so nobody can decide it now." : "This request was already decided.");

 
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

/** Every budget an owner holds counts toward the cap through one of these, so a top-up can't get round it through any of them. */
export const OWNER_TOTAL_CONTRIBUTORS: OwnerTotalContributor[] = [agentBudgets];

/**
 * What one owner's budgets total this month, top-ups included (every `OWNER_TOTAL_CONTRIBUTORS`), and the owner counter's `version` read before the sum (R4-6).
 * A change after that read moves the version, so an approval conditional on it can't apply on a stale sum. `owner` is a member already read as its survivor.
 */
export async function ownerEffectiveTotal(deps: SpendRequestDependencies, input: { orgId: OrgId; owner: string; month: string }): Promise<{ totalUsd: number; version: number }> {
  await deps.store.ensureOwnerTotal(input.orgId, input.owner);
  const counter = await getItem(deps, ownerBudgetKey(input.orgId, input.owner));
  const version = typeof counter?.["version"] === "number" ? counter["version"] : 0;
  let totalUsd = 0;
  for (const contributor of OWNER_TOTAL_CONTRIBUTORS) totalUsd += await contributor(deps, input);
  return { totalUsd: cleanUsd(totalUsd), version };
}

/** The UTC month a `month` request tops up: the month it was made in. */
const monthOfRequest = (record: Pick<SpendRequestRecord, "createdAt">): string => {
  const stored = (record as { topUpMonth?: unknown }).topUpMonth;
  return typeof stored === "string" ? stored : record.createdAt.slice(0, 7);
};

/** How a `month` request is routed for each kind of scope (Plan 4 adds `chain`). */
export type MonthApproverRule = (deps: SpendRequestDependencies, request: SpendRequestRecord, amountUsd: number) => Promise<SpendApprovers>;

const toAdmins: MonthApproverRule = (deps, request) => admins(deps, request.orgId);

/**
 * An agent's month goes to its owner while its new limit stays within the guardrail's `maxAgentMonthlyUsd` and the owner's effective total with the top-up stays
 * within `ownerAgentBudgetCapUsd`; else (a human decision) to the org's owners and admins. A built-in, or an agent no one is answerable for, goes to the admins.
 */
const agentMonth: MonthApproverRule = async (deps, request, amountUsd) => {
  const { orgId } = request;
  const scope = request.scope as Extract<BudgetScope, { kind: "agent" }>;
  if (isBuiltinAgentId(scope.agentId)) return admins(deps, orgId);
  const agent = await deps.store.get(orgId, scope.agentId);
  const raw = agent === undefined ? undefined : budgetOwnerOf(agent);
  if (raw === undefined) return admins(deps, orgId);
  const owner = await resolveSurvivor(deps, orgId, raw);
  if (newLimitFor(request, amountUsd) > (await readGuardrails(deps, orgId)).maxAgentMonthlyUsd) return admins(deps, orgId);
  const { totalUsd, version } = await ownerEffectiveTotal(deps, { orgId, owner, month: monthOfRequest(request) });
  if (cleanUsd(totalUsd + amountUsd) > (await readSpendPolicy(deps, orgId)).ownerAgentBudgetCapUsd) return admins(deps, orgId);
  const owners = await agentOwners(deps, orgId, scope.agentId);
  return owners.role === "org_admin" ? owners : { ...owners, owner: { developerId: owner, version } };
};

export const MONTH_APPROVERS: Record<BudgetScope["kind"], MonthApproverRule> = {
  org: toAdmins,
  member: toAdmins,
  project: toAdmins,
  testing: toAdmins,
  agent: agentMonth,
};

const BUDGET_SCOPE_KINDS = new Set(["org", "member", "project", "agent", "testing"]);
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

/** The payer of a task, as approvers: the member who pays, a paying project's maintainers, a paying agent's owner. */
async function payerOf(deps: SpendRequestDependencies, orgId: OrgId, task: DeveloperTaskRecord): Promise<SpendApprovers> {
  const payer = task.payer ?? { kind: "member" as const, developerId: task.developerId };
  if (payer.kind === "member") return { role: "payer", ids: [payer.developerId], who: await nameOf(deps, payer.developerId) };
  if (payer.kind === "project") {
    const ids = await grantMaintainers(deps, orgId, payer.project);
    return ids.length > 0 ? { role: "payer", ids, who: maintainersWho(payer.project) } : admins(deps, orgId);
  }
  const owners = await agentOwners(deps, orgId, payer.agentId);
  return owners.role === "org_admin" ? owners : { ...owners, role: "payer" };
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
 *   - `owner_cap` and `month`: the org's owners and admins.
 * A list that names nobody who is still a member (a payer who left) falls to the org's owners and admins.
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
    if (limit <= policy.leadApprovalThresholdUsd) found = await payerOf(deps, orgId, task);
    else if (limit <= policy.adminApprovalThresholdUsd) found = await maintainersOrAdmins(deps, orgId, project, "project_maintainer");
    else found = await admins(deps, orgId);
  } else if (request.kind === "max_per_run") {
    const task = await readTask(deps, orgId, request.taskId);
    const agentId = task?.agent?.agentId;
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
  return members.some(Boolean) ? found : admins(deps, orgId);
}

/** The words a pause message uses for who was asked. */
const askedWords = (role: SpendApproverRole): string => (role === "payer" ? "the payer" : role === "project_maintainer" ? "a project maintainer" : role === "agent_owner" ? "the agent's owner" : "an admin");

/** The payer of a task request, read now (who "the payer" is). */
async function taskPayerId(deps: SpendRequestDependencies, record: SpendRequestRecord): Promise<string | undefined> {
  const task = await readTask(deps, record.orgId, record.taskId);
  const payer = task === undefined ? undefined : task.payer ?? { kind: "member" as const, developerId: task.developerId };
  return payer?.kind === "member" ? payer.developerId : undefined;
}

/**
 * Whether `caller` may decide `record` for `amountUsd` now: they are one of its approvers (a merged duplicate counting as its survivor), and not the person who
 * asked, unless they are the task's payer or, for an `owner_cap` request, the org's only owner or admin.
 */
async function mayDecideNow(deps: SpendRequestDependencies, caller: Pick<AgentCaller, "orgId" | "developerId">, record: SpendRequestRecord, amountUsd?: number): Promise<{ allowed: boolean; who: string }> {
  const approvers = await spendApprovers(deps, record, amountUsd);
  const me = await resolveSurvivor(deps, caller.orgId, caller.developerId);
  if (await orgRoleOf(deps, caller.orgId, me) === undefined) return { allowed: false, who: approvers.who };
  const survivors = await Promise.all(approvers.ids.map((id) => resolveSurvivor(deps, caller.orgId, id)));
  if (!survivors.includes(me)) return { allowed: false, who: approvers.who };
  if (record.requestedBy.kind === "member" && await resolveSurvivor(deps, caller.orgId, record.requestedBy.developerId) === me) {
    if (record.kind === "owner_cap") return { allowed: survivors.every((id) => id === me), who: approvers.who };
    const payer = await taskPayerId(deps, record);
    return { allowed: payer !== undefined && await resolveSurvivor(deps, caller.orgId, payer) === me, who: approvers.who };
  }
  return { allowed: true, who: approvers.who };
}

// ---- making a request

export interface CreateSpendRequestInput {
  orgId: OrgId;
  kind: SpendRequestKind;
  scope?: PauseScope;
  taskId?: string;
  agentId?: string;
  newOwner?: { developerId: string };
  amountUsd: number;
  newLimitUsd?: number;
  /** What the person deciding is told; a function when the words name who was asked (known once the approvers are read). */
  reason: string | ((approvers: SpendApprovers, amountUsd: number) => string);
  requestedBy: SpendRequestRecord["requestedBy"];
  resume?: SpendRequestRecord["resume"];
  change?: OwnerCapChange;
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

const audited = (deps: SpendRequestDependencies, build: () => AuditEventInput[]): Promise<AuditEventInput[]> => tryAuditEvents(deps, build);
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
      ...(input.newOwner === undefined ? {} : { newOwner: input.newOwner }),
      amountUsd: cleanUsd(input.amountUsd), ...(input.newLimitUsd === undefined ? {} : { newLimitUsd: cleanUsd(input.newLimitUsd) }),
      reason: "", requestedBy: input.requestedBy, approverRole: "org_admin", approverIds: [], status: "PENDING",
      ...(input.resume === undefined ? {} : { resume: input.resume }), ...(input.change === undefined ? {} : { change: input.change }),
      createdAt, expiresAt: iso(now + SPEND_REQUEST_TTL_DAYS * DAY_MS),
    };
    const approvers = await spendApprovers(deps, draft);
    const reason = cleanReason(typeof input.reason === "string" ? input.reason : input.reason(approvers, draft.amountUsd));
    const record: SpendRequestRecord = { ...draft, reason, approverRole: approvers.role, approverIds: approvers.ids };
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
      { Put: { TableName: deps.tableName, Item: { ...openSpendRequestDueKey(createdAt, record.orgId, record.spendRequestId), entityType: "SPEND_REQUEST_DUE", orgId: record.orgId, spendRequestId: record.spendRequestId } } },
      ...extra,
      ...events.flatMap((event) => auditPending(deps, event)),
      ...(input.request === undefined ? [] : [requestMarkItem(deps, input.request, input.requestResult?.(record, approvers) ?? { spendRequestId: record.spendRequestId })]),
    ];
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      const failed = failedIndexes(error);
      // Another request took the slot first: answer that one.
      if (failed?.has(1) === true) continue;
      if (failed !== undefined && input.request !== undefined && failed.has(items.length - 1)) throw agentXError("IDEMPOTENCY_CONFLICT", "This request ID is already being used for another change.");
      throw error;
    }
    await flushAuditEvents(deps, events);
    return { record, created: true, approvers };
  }
  throw agentXError("AGENT_REVISION_CONFLICT", "Someone else asked for this at the same time. Try again.");
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
  const kind = stop < runLimit ? "max_per_run" : refusal.workflowMode === "PLAN" ? "planning" : "task";
  return { kind, taskId: task.taskId };
}

/**
 * The task's budget ran out (its operation ended `budget_exhausted`): the request its pause asks for. A task-level pause asks the person who may raise that limit;
 * a test's cap asks for nothing (the task's owner may continue it as a normal task); a month's budget asks for nothing here. A pause the task has not got is
 * derived from the end (`derivedPause`) and written first. Answers the request, or undefined when nothing was asked.
 */
export async function requestForPausedTask(deps: SpendRequestDependencies, taskId: string, refusal: { workflowMode?: string } = {}): Promise<SpendRequestRecord | undefined> {
  let task = await getItem(deps, taskKey(taskId)) as DeveloperTaskRecord | undefined;
  if (task?.orgId === undefined) return undefined;
  const orgId = task.orgId;
  if (task.budgetPause === undefined) {
    const scope = await derivedPause(deps, task, refusal);
    if (scope === undefined) return undefined;
    const pause = { scope, at: iso(deps.now()) };
    try {
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName, Key: taskKey(taskId), UpdateExpression: "SET #pause = :pause",
        ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(#pause)", ExpressionAttributeNames: { "#pause": "budgetPause" }, ExpressionAttributeValues: { ":pause": pause },
      }));
    } catch (error) {
      if (errorName(error) !== "ConditionalCheckFailedException") throw error;
    }
    task = await getItem(deps, taskKey(taskId)) as DeveloperTaskRecord | undefined;
    if (task?.budgetPause === undefined || task.orgId !== orgId) return undefined;
  }
  const pause = task.budgetPause;
  const scope = pause.scope;
  if (isBudgetScope(scope)) return requestForMonth(deps, task, { scope, at: pause.at });
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
  const { message, ...create } = input;
  // The pause message names who was asked; the task event carrying it commits with the request.
  const made = await createSpendRequest(deps, {
    ...create, reason: message,
    extraItems: (record) => [taskEventItem(deps, task, record.createdAt, `spr${record.spendRequestId}`, record.reason)],
  });
  return made.record;
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
  }
}

/**
 * A task stopped by a month's budget: it is listed under that scope (`pausedTasksKey`), so the top-up resumes it with every other task the same budget stopped,
 * and the scope's month asks once (one PENDING per month, scope and requester; a pause asks as the system). A scope with no limit asks for nothing (R47).
 */
async function requestForMonth(deps: SpendRequestDependencies, task: DeveloperTaskRecord, pause: { scope: BudgetScope; at: string }): Promise<SpendRequestRecord | undefined> {
  const orgId = task.orgId as OrgId;
  const { scope } = pause;
  const month = iso(deps.now()).slice(0, 7);
  await deps.documentClient.send(new PutCommand({
    TableName: deps.tableName,
    Item: { ...pausedTasksKey(orgId, pauseKey(scope), task.taskId), entityType: "PAUSED_TASK", orgId, taskId: task.taskId, scope, pausedAt: pause.at },
  }));
  const limit = (await effectiveLimits(deps, { orgId, month, scopes: [scope] })).get(scopeKey(scope));
  if (limit === undefined) return undefined;
  const amountUsd = suggestedMonthTopUpUsd(limit);
  const made = await createSpendRequest(deps, {
    orgId, kind: "month", scope, subject: monthSubject(month, scope, "system"), amountUsd, newLimitUsd: cleanUsd(limit + amountUsd),
    requestedBy: { kind: "system" }, reason: (approvers, amount) => monthMessage(scope, task, approvers, amount),
    extraItems: (record) => [taskEventItem(deps, task, record.createdAt, `spr${record.spendRequestId}`, record.reason)],
  });
  return made.record;
}

/**
 * The top-up's own approval: every task listed under the scope that is still paused on it goes on (its pause removed with its item, conditional on the pause it
 * was listed for), keeping its cap window; a task that closed or now waits on another limit only loses its item. A resume that fails is logged: the task is no
 * longer paused, and its owner's Continue goes on.
 */
async function resumeMonthTasks(deps: SpendRequestDependencies, record: SpendRequestRecord, scope: BudgetScope): Promise<void> {
  const pk = pausedTasksKey(record.orgId, pauseKey(scope), "-").pk;
  for (const item of await queryAll(deps, pk)) {
    const taskId = String(item["sk"]);
    const key = { pk, sk: taskId };
    const task = await readTask(deps, record.orgId, taskId);
    const waits = task !== undefined && task.closedAt === undefined && task.budgetPause !== undefined && pauseKey(task.budgetPause.scope) === pauseKey(scope);
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Delete: { TableName: deps.tableName, Key: key } },
        ...(waits ? [{
          Update: {
            TableName: deps.tableName, Key: taskKey(taskId), UpdateExpression: "SET updatedAt = :now REMOVE budgetPause",
            ConditionExpression: "budgetPause.#at = :at AND attribute_not_exists(closedAt)", ExpressionAttributeNames: { "#at": "at" },
            ExpressionAttributeValues: { ":now": iso(deps.now()), ":at": task.budgetPause!.at },
          },
        }] : []),
      ] }));
    } catch (error) {
      if (failedIndexes(error) === undefined) throw error;
      continue;
    }
    if (!waits) continue;
    try {
      await deps.spendRequests?.resumeTask({ orgId: record.orgId, taskId, spendRequestId: record.spendRequestId, resetRunWindow: false, firstDispatch: false });
    } catch (error) {
      logLine(deps, "spend_request.resume_failed", { spendRequestId: record.spendRequestId, taskId, error: errorName(error) });
    }
  }
}

/** An expired month's request leaves its tasks paused (their owners may ask again); the items that listed them for it are deleted. */
async function forgetPausedTasks(deps: SpendRequestDependencies, record: SpendRequestRecord): Promise<void> {
  if (record.kind !== "month" || !isBudgetScope(record.scope)) return;
  const pk = pausedTasksKey(record.orgId, pauseKey(record.scope), "-").pk;
  for (const item of await queryAll(deps, pk)) {
    await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk, sk: String(item["sk"]) } }));
  }
}

// ---- an owner's cap

const ownerCapSentence = (name: string, wouldBeUsd: number, capUsd: number) => `${name}'s agent budgets would total ${dollars(wouldBeUsd)} a month, over the ${dollars(capUsd)} limit for one person.`;
/** What the person whose change waits is told. */
export const ownerCapMessage = (reason: string) => `${reason} I asked an org admin to approve it.`;

/**
 * The `owner_cap` request of a change held by the cap (Task 28's seam, PF27): made once per agent, and the change waits for an org admin. Nothing changes while it
 * is PENDING; `request` is the asking route's R18 mark, which remembers the 202 answer. Answers the request and the words the route answers with.
 */
export async function requestOwnerCap(deps: SpendRequestDependencies, input: {
  orgId: OrgId; agentId: string; requestedBy: string; owner: string; wouldBeUsd: number; capUsd: number; newLimitUsd?: number; newOwner?: string; change: OwnerCapChange; request?: RequestMark;
}): Promise<{ record: SpendRequestRecord; message: string }> {
  const reason = ownerCapSentence(await nameOf(deps, input.owner), input.wouldBeUsd, input.capUsd);
  const made = await createSpendRequest(deps, {
    orgId: input.orgId, kind: "owner_cap", scope: { kind: "agent", agentId: input.agentId }, agentId: input.agentId,
    ...(input.newOwner === undefined ? {} : { newOwner: { developerId: input.newOwner } }),
    amountUsd: cleanUsd(input.wouldBeUsd - input.capUsd), ...(input.newLimitUsd === undefined ? {} : { newLimitUsd: input.newLimitUsd }),
    reason, requestedBy: { kind: "member", developerId: input.requestedBy }, change: input.change,
    ...(input.request === undefined ? {} : { request: input.request }),
    requestResult: (record) => ({ status: "NEEDS_ADMIN_APPROVAL", spendRequestId: record.spendRequestId, message: ownerCapMessage(record.reason) }),
  });
  return { record: made.record, message: ownerCapMessage(made.record.reason) };
}

/**
 * Rovara's own move left `owner` over the cap (Task 11's seam): the move already applied and counted, so an `owner_cap` request asks an org admin to confirm it.
 * Once per person while one is open; nothing when the total is within the cap.
 */
export async function confirmOwnerMove(deps: SpendRequestDependencies, orgId: OrgId, owner: string, cause: "member_merged" | "member_removed", totals: { totalUsd: number; capUsd: number }): Promise<SpendRequestRecord | undefined> {
  if (totals.totalUsd <= totals.capUsd) return undefined;
  const made = await createSpendRequest(deps, {
    orgId, kind: "owner_cap", subject: `OWNER#${owner}`, amountUsd: cleanUsd(totals.totalUsd - totals.capUsd), newLimitUsd: totals.totalUsd,
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

/** A request as an answer shows it: no org, no keys; the page where it is decided. */
export function spendRequestView(deps: Pick<SpendRequestDependencies, "confirmOrigin" | "now">, record: SpendRequestRecord): Record<string, unknown> {
  const { orgId: _orgId, change: _change, slotSubject: _slot, ownerVersion: _version, ...shown } = record as SpendRequestRecord & { slotSubject?: string; ownerVersion?: number }; // eslint-disable-line @typescript-eslint/no-unused-vars -- the org is the caller's; the stored change, slot and version are the store's
  // A request whose time ran out reads EXPIRED before the sweep has ended it: nobody can decide it any more.
  const expired = record.status === "PENDING" && Date.parse(record.expiresAt) <= deps.now();
  return { ...shown, ...(expired ? { status: "EXPIRED" } : {}), confirmUrl: `${deps.confirmOrigin}/v1/app/approve/${record.spendRequestId}` };
}

/** The end of a request in one write: its record (conditional on PENDING), its index items and its slot. */
function endItems(deps: SpendRequestDependencies, record: SpendRequestRecord, set: Item): TransactItem[] {
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
    { Delete: { TableName: deps.tableName, Key: openSpendRequestDueKey(record.createdAt, record.orgId, record.spendRequestId) } },
    { Delete: { TableName: deps.tableName, Key: spendRequestSlotKey(record.orgId, subjectOfRecord(record), record.kind), ConditionExpression: "attribute_not_exists(pk) OR spendRequestId = :id", ExpressionAttributeValues: { ":id": record.spendRequestId } } },
  ];
}

const subjectOfRecord = (record: SpendRequestRecord): string => {
  const stored = (record as { slotSubject?: unknown }).slotSubject;
  return typeof stored === "string" ? stored : legacySubjectOf(record);
};
const legacySubjectOf = (record: SpendRequestRecord): string =>
  record.change?.op === "confirm_move" ? `OWNER#${record.change.owner}` : subjectOf({ ...(record.taskId === undefined ? {} : { taskId: record.taskId }), ...(record.agentId === undefined ? {} : { agentId: record.agentId }) });

/** What an approval of a task's request changes on the task, conditional on the figures read; and how the task goes on. */
async function taskChange(deps: SpendRequestDependencies, record: SpendRequestRecord, task: DeveloperTaskRecord, approvedUsd: number): Promise<{ items: TransactItem[]; resetRunWindow: boolean; firstDispatch: boolean; raisedPastRunLimit?: number }> {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = { ":org": task.orgId };
  const sets: string[] = ["updatedAt = :now"];
  values[":now"] = iso(deps.now());
  const conditions = ["attribute_exists(pk)", "orgId = :org", "attribute_not_exists(closedAt)"];
  const removes: string[] = [];
  const pauseKind = task.budgetPause?.scope.kind;
  const firstDispatch = task.budgetPause?.firstDispatch !== undefined;
  const same = (attribute: string, value: unknown) => {
    names[`#${attribute}`] = attribute;
    if (value === undefined) conditions.push(`attribute_not_exists(#${attribute})`);
    else {
      values[`:was_${attribute}`] = value;
      conditions.push(`#${attribute} = :was_${attribute}`);
    }
  };
  let resetRunWindow = false;
  let raisedPastRunLimit: number | undefined;
  if (record.kind === "run_limit" || record.kind === "planning") {
    same("budgetUsd", task.budgetUsd);
    names["#budgetUsd"] = "budgetUsd";
    values[":limit"] = newLimitFor(record, approvedUsd);
    sets.push("#budgetUsd = :limit");
    resetRunWindow = record.kind === "planning" || record.resume === "implement";
    if (resetRunWindow) {
      const spentOf = deps.spendRequests?.taskSpentUsd;
      // A window can only be reset at what the keys have spent: a proxy that can't say refuses the approval (retryable), nothing is written.
      if (spentOf === undefined) throw agentXError("MODEL_PROXY_UNAVAILABLE", "the model proxy can't say what this task has spent; try again in a minute");
      values[":baseline"] = cleanUsd(await spentOf(task.modelKeyIds ?? []));
      sets.push("budgetBaselineUsd = :baseline");
    }
    // A run held at its start is dispatched by the resume, which takes the pause in the same write as the dispatch.
    if (!firstDispatch && (pauseKind === "task" || pauseKind === "planning")) removes.push("budgetPause");
  } else if (record.kind === "max_per_run") {
    same("maxPerRunUsd", task.maxPerRunUsd);
    const stop = newLimitFor(record, approvedUsd);
    names["#maxPerRunUsd"] = "maxPerRunUsd";
    values[":stop"] = stop;
    sets.push("#maxPerRunUsd = :stop");
    if (pauseKind === "max_per_run") removes.push("budgetPause");
    if (stop > runLimitOf(task)) raisedPastRunLimit = runLimitOf(task);
  }
  const update = {
    Update: {
      TableName: deps.tableName, Key: taskKey(task.taskId),
      UpdateExpression: `SET ${sets.join(", ")}${removes.length === 0 ? "" : ` REMOVE ${removes.join(", ")}`}`,
      ConditionExpression: conditions.join(" AND "),
      ...(Object.keys(names).length === 0 ? {} : { ExpressionAttributeNames: names }), ExpressionAttributeValues: values,
    },
  };
  return { items: [update], resetRunWindow, firstDispatch, ...(raisedPastRunLimit === undefined ? {} : { raisedPastRunLimit }) };
}

/** The run limit request that follows a max-per-run raise past the run limit: who it goes to, worked out before the approval writes its event. */
function followUpRunLimit(task: DeveloperTaskRecord, limitUsd: number): Omit<CreateSpendRequestInput, "reason"> {
  const amountUsd = suggestedTopUpUsd(limitUsd);
  return {
    orgId: task.orgId as OrgId, kind: "run_limit", scope: { kind: "task", taskId: task.taskId }, taskId: task.taskId, amountUsd, newLimitUsd: cleanUsd(limitUsd + amountUsd),
    requestedBy: { kind: "system" }, resume: "continue",
  };
}

/** Applies an approved `owner_cap` request's stored change through the store, with the request's own end in the same transaction. */
async function applyOwnerCap(deps: SpendRequestDependencies, record: SpendRequestRecord, by: string, items: TransactItem[]): Promise<void> {
  const change = record.change;
  const agentId = record.agentId as never;
  const options = { overrideCap: { spendRequestId: record.spendRequestId, items, closed: () => closed({ status: "APPROVED" }) } };
  if (change === undefined || change.op === "confirm_move") {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    return;
  }
  switch (change.op) {
    case "set_budget": await deps.store.setBudget(record.orgId, agentId, change.budget, by, undefined, options); return;
    case "set_owner": await deps.store.setOwner(record.orgId, agentId, change.owner, by, change.accountable, undefined, options); return;
    case "set_accountable": await deps.store.setAccountable(record.orgId, agentId, change.accountable, by, undefined, options); return;
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
  const approvedUsd = body.decision === "APPROVE" ? cleanUsd(body.amountUsd ?? record.amountUsd) : undefined;
  // Who may is asked first, so a person who may not learns nothing about how it ended.
  const may = await mayDecideNow(deps, caller, record, approvedUsd);
  if (!may.allowed) throw agentXError("FORBIDDEN", `Only ${may.who} can decide this.`);
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
    throw error instanceof AgentXError ? error : agentXError("AGENT_REVISION_CONFLICT", "The task changed while this was decided. Open the request again.");
  };
  if (record.kind === "month") return decideMonth(deps, record, { status, approvedUsd, answer, events, ending, refused });
  if (record.kind === "owner_cap" && status === "APPROVED") {
    try {
      await applyOwnerCap(deps, record, decidedBy, ending);
    } catch (error) {
      if (error instanceof AgentXError) throw error;
      await refused(error);
    }
    await flushAuditEvents(deps, events);
    return answer;
  }
  const task = status === "APPROVED" && record.taskId !== undefined ? await readTask(deps, record.orgId, record.taskId) : undefined;
  if (status === "APPROVED" && record.taskId !== undefined && task === undefined) throw notFound();
  const change = task === undefined || approvedUsd === undefined ? undefined : await taskChange(deps, record, task, approvedUsd);
  let followUp: Omit<CreateSpendRequestInput, "reason"> | undefined;
  let followUpWords: string | undefined;
  const extra: TransactItem[] = [];
  if (task !== undefined && change?.raisedPastRunLimit !== undefined) {
    followUp = followUpRunLimit(task, change.raisedPastRunLimit);
    const draft = { ...record, ...followUp, spendRequestId: record.spendRequestId, reason: "", status: "PENDING" } as SpendRequestRecord;
    const asked = await spendApprovers(deps, draft);
    followUpWords = askedWords(asked.role);
    extra.push(taskEventItem(deps, task, decidedAt, `spr${record.spendRequestId}d`,
      `That is more than this run's ${dollars(change.raisedPastRunLimit)} run limit, so I also asked ${followUpWords} to raise it.`));
  }
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [...ending, ...(change?.items ?? []), ...extra] }));
  } catch (error) {
    await refused(error);
  }
  await flushAuditEvents(deps, events);
  if (task !== undefined && change !== undefined) {
    if (followUp !== undefined && followUpWords !== undefined) {
      const words = followUpWords;
      const made = await createSpendRequest(deps, { ...followUp, reason: `This task needs about ${dollars(followUp.amountUsd)} more to finish. I asked ${words} to approve it.` })
        .catch((error: unknown) => { logLine(deps, "spend_request.follow_up_failed", { spendRequestId: record.spendRequestId, error: errorName(error) }); return undefined; });
      void made;
    }
    // The decision stands whatever happens next; a resume that fails is logged, and the owner's Continue (or the engine's sweep) goes on from the raised limit.
    try {
      await deps.spendRequests?.resumeTask({ orgId: record.orgId, taskId: task.taskId, spendRequestId: record.spendRequestId, resetRunWindow: change.resetRunWindow, firstDispatch: change.firstDispatch });
    } catch (error) {
      logLine(deps, "spend_request.resume_failed", { spendRequestId: record.spendRequestId, taskId: task.taskId, error: errorName(error) });
    }
  }
  return answer;
}

/**
 * A `month` decision. An approval ADDs the top-up for the scope and the request's month, in the transaction that ends the request; an agent's also moves the
 * owner counter's `version`, and one routed to the owner applies only while that version is the one the owner's total was just summed at (R4-6). A lost race
 * re-reads the total once and re-routes the request (to the admins when it is now over the cap), applying nothing. Then every task the budget stopped goes on.
 */
async function decideMonth(deps: SpendRequestDependencies, record: SpendRequestRecord, decision: {
  status: "APPROVED" | "DENIED"; approvedUsd: number | undefined; answer: { spendRequest: Record<string, unknown> }; events: AuditEventInput[]; ending: TransactItem[]; refused: (error: unknown) => Promise<never>;
}): Promise<{ spendRequest: Record<string, unknown>; rerouted?: boolean }> {
  const scope = record.scope;
  if (!isBudgetScope(scope)) throw notFound();
  const items = [...decision.ending];
  let versionAt: number | undefined;
  if (decision.status === "APPROVED" && decision.approvedUsd !== undefined) {
    items.push({
      Update: {
        TableName: deps.tableName, Key: topUpKey(record.orgId, monthOfRequest(record), scope),
        UpdateExpression: "SET entityType = :type, orgId = :org, updatedAt = :now ADD amountUsd :amount",
        ExpressionAttributeValues: { ":type": "TOPUP", ":org": record.orgId, ":now": iso(deps.now()), ":amount": decision.approvedUsd },
      },
    });
    if (scope.kind === "agent") {
      const approvers = await spendApprovers(deps, record, decision.approvedUsd);
      const owner = approvers.owner?.developerId ?? await agentBudgetOwner(deps, record.orgId, scope.agentId);
      if (owner !== undefined) {
        await deps.store.ensureOwnerTotal(record.orgId, owner);
        versionAt = approvers.owner === undefined ? undefined : items.length;
        items.push(ownerVersionItem(deps, record.orgId, owner, approvers.owner?.version));
      }
    }
  }
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    if (versionAt !== undefined && failedIndexes(error)?.has(versionAt) === true && failedIndexes(error)?.has(0) !== true) {
      return { spendRequest: spendRequestView(deps, await reroute(deps, record)), rerouted: true };
    }
    await decision.refused(error);
  }
  await flushAuditEvents(deps, decision.events);
  if (decision.status === "APPROVED") await resumeMonthTasks(deps, record, scope);
  return decision.answer;
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
async function reroute(deps: SpendRequestDependencies, record: SpendRequestRecord): Promise<SpendRequestRecord> {
  const approvers = await spendApprovers(deps, record);
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
  ] }));
  await flushAuditEvents(deps, events);
  return { ...record, approverRole: approvers.role, approverIds: approvers.ids };
}

// ---- the settlement run: escalation and expiry (PF13)

/**
 * Every open request oldest first: one whose time ran out is EXPIRED (the task stays paused; an `owner_cap` change never applies); a `max_per_run` request its
 * owner has not answered for `OWNER_ANSWER_HOURS` gets the org's owners and admins added (`escalatedAt`). Each change is conditional on the record being
 * PENDING and unescalated, audited in the same transaction. Stops at `budgetMs` or at the first request too young for either.
 */
export async function escalateOwnerRequests(deps: SpendRequestDependencies, options: { budgetMs: number }): Promise<{ escalated: number; expired: number; complete: boolean }> {
  const deadline = deps.now() + options.budgetMs;
  const now = deps.now();
  const youngest = now - OWNER_ANSWER_HOURS * 3_600_000;
  const result = { escalated: 0, expired: 0, complete: false };
  let start: Record<string, unknown> | undefined;
  for (;;) {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": "OPEN_SPEND_REQUESTS" }, ConsistentRead: true, Limit: PAGE,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      if (deps.now() >= deadline) return result;
      const orgId = item["orgId"];
      const id = item["spendRequestId"];
      if (typeof orgId !== "string" || typeof id !== "string") continue;
      const record = await getSpendRequest(deps, orgId, id);
      if (record === undefined || record.status !== "PENDING") {
        // A request that ended keeps no place in the due list.
        await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Delete: { TableName: deps.tableName, Key: { pk: String(item["pk"]), sk: String(item["sk"]) } } }] })).catch(() => undefined);
        continue;
      }
      // Oldest first: once a request is too young to escalate and has time left, so has every later one.
      if (Date.parse(record.createdAt) > youngest && Date.parse(record.expiresAt) > now) {
        result.complete = true;
        return result;
      }
      try {
        if (Date.parse(record.expiresAt) <= now) {
          if (await expireOne(deps, record)) result.expired += 1;
        } else if (record.kind === "max_per_run" && record.escalatedAt === undefined && record.approverRole !== "org_admin") {
          if (await escalateOne(deps, record)) result.escalated += 1;
        }
      } catch (error) {
        logLine(deps, "spend_request.sweep_failed", { spendRequestId: record.spendRequestId, error: errorName(error) });
      }
    }
    start = page.LastEvaluatedKey;
    if (start === undefined) {
      result.complete = true;
      return result;
    }
  }
}

async function expireOne(deps: SpendRequestDependencies, record: SpendRequestRecord): Promise<boolean> {
  const at = iso(deps.now());
  const events = await audited(deps, () => [auditSpendRequestExpired({ orgId: record.orgId, actor: auditActorOf("system"), occurredAt: at, occurrence: record.spendRequestId, ...facts(record) })]);
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [...endItems(deps, record, { status: "EXPIRED", expiredAt: at }), ...events.flatMap((event) => auditPending(deps, event))] }));
  } catch (error) {
    if (failedIndexes(error)?.has(0) === true) return false;
    throw error;
  }
  await flushAuditEvents(deps, events);
  await forgetPausedTasks(deps, record);
  return true;
}

async function escalateOne(deps: SpendRequestDependencies, record: SpendRequestRecord): Promise<boolean> {
  const at = iso(deps.now());
  const ids = [...new Set([...record.approverIds, ...await orgAdmins(deps, record.orgId)])].sort();
  const events = await audited(deps, () => [auditSpendRequestEscalated({ orgId: record.orgId, actor: auditActorOf("system"), occurredAt: at, occurrence: record.spendRequestId, ...facts(record) })]);
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      {
        Update: {
          TableName: deps.tableName, Key: spendRequestKey(record.orgId, record.spendRequestId), UpdateExpression: "SET escalatedAt = :at, approverIds = :ids",
          ConditionExpression: "#status = :pending AND attribute_not_exists(escalatedAt)", ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":at": at, ":ids": ids, ":pending": "PENDING" },
        },
      },
      { Put: { TableName: deps.tableName, Item: { ...openSpendRequestsKey(record.orgId, record.createdAt, record.spendRequestId), entityType: "SPEND_REQUEST_OPEN", orgId: record.orgId, spendRequestId: record.spendRequestId, approverIds: ids } } },
      ...events.flatMap((event) => auditPending(deps, event)),
    ] }));
  } catch (error) {
    if (failedIndexes(error)?.has(0) === true) return false;
    throw error;
  }
  await flushAuditEvents(deps, events);
  return true;
}

// ---- the member movers (PF14)

/** Moves one open request's mentions of `from` to `to`: conditional on it being PENDING and unmoved since it was read, audited as the system's. */
async function moveOne(deps: LifecycleDeps, record: SpendRequestRecord, from: string, to: string, mode: "merged" | "removed"): Promise<void> {
  const stored = await getItem(deps, spendRequestKey(record.orgId, record.spendRequestId));
  const revision = typeof stored?.["moveRevision"] === "number" ? stored["moveRevision"] : 0;
  const ids = [...new Set(record.approverIds.map((id) => (id === from ? to : id)))].sort();
  const requestedBy = record.requestedBy.kind === "member" && record.requestedBy.developerId === from ? { kind: "member" as const, developerId: to } : record.requestedBy;
  const newOwner = record.newOwner?.developerId === from ? { developerId: to } : record.newOwner;
  const at = iso(deps.now());
  const events = await tryAuditEvents(deps, () => [auditSpendRequestRerouted({
    orgId: record.orgId, actor: auditActorOf("system"), occurredAt: at, occurrence: auditOccurrence(record.spendRequestId, String(revision + 1)), spendRequestId: record.spendRequestId, kind: record.kind, mode, from, to,
  })]);
  await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
    {
      Update: {
        TableName: deps.tableName, Key: spendRequestKey(record.orgId, record.spendRequestId),
        UpdateExpression: `SET approverIds = :ids, requestedBy = :by, movedBy = :system, movedAt = :at, moveRevision = :next${newOwner === undefined ? "" : ", newOwner = :owner"}`,
        ConditionExpression: revision === 0 ? "#status = :pending AND attribute_not_exists(moveRevision)" : "#status = :pending AND moveRevision = :seen",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":ids": ids, ":by": requestedBy, ":system": "system", ":at": at, ":next": revision + 1, ":pending": "PENDING",
          ...(newOwner === undefined ? {} : { ":owner": newOwner }), ...(revision === 0 ? {} : { ":seen": revision }),
        },
      },
    },
    { Put: { TableName: deps.tableName, Item: { ...openSpendRequestsKey(record.orgId, record.createdAt, record.spendRequestId), entityType: "SPEND_REQUEST_OPEN", orgId: record.orgId, spendRequestId: record.spendRequestId, approverIds: ids } } },
    ...events.flatMap((event) => auditPending(deps, event)),
  ] }));
  await flushAuditEvents(deps, events);
}

/** Every open request of the org that names `from` (as an approver, the asker or the new owner) is handed to `to`. Repeatable; time-bound by `checkTime`. */
async function moveRequests(deps: LifecycleDeps, orgId: OrgId, from: string, to: string, mode: "merged" | "removed"): Promise<void> {
  const open = await queryAll(deps, openSpendRequestsKey(orgId, "2000-01-01T00:00:00.000Z", "spr_0").pk);
  for (const item of open) {
    const ids = item["approverIds"];
    const id = item["spendRequestId"];
    if (typeof id !== "string") continue;
    checkTime(deps);
    const record = await getSpendRequest(deps, orgId, id);
    if (record === undefined || record.status !== "PENDING") continue;
    const names = record.approverIds.includes(from) || (record.requestedBy.kind === "member" && record.requestedBy.developerId === from) || record.newOwner?.developerId === from;
    if (!names && !(Array.isArray(ids) && ids.includes(from))) continue;
    for (let tried = 0; ; tried += 1) {
      try {
        await moveOne(deps, (await getSpendRequest(deps, orgId, id)) ?? record, from, to, mode);
        break;
      } catch (error) {
        if (failedIndexes(error) === undefined || tried >= 2) throw error;
        const again = await getSpendRequest(deps, orgId, id);
        if (again === undefined || again.status !== "PENDING") break;
      }
    }
  }
}

registerOwnerCapConfirmation((deps, orgId, owner, cause, totals) => confirmOwnerMove(deps as SpendRequestDependencies, orgId, owner, cause, totals));

registerMemberMover({
  name: "spend-requests",
  merged: (deps, { orgId, survivorId, duplicateId }) => moveRequests(deps, orgId, duplicateId, survivorId, "merged"),
  removed: (deps, { orgId, developerId, successorId }) => moveRequests(deps, orgId, developerId, successorId, "removed"),
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
    facts_.push(fact("Payer", payer.kind === "member" ? await nameOf(deps, payer.developerId) : payer.kind === "project" ? `the ${payer.project} project` : "the agent's budget"));
    facts_.push(fact("Project", task.place?.project ?? task.project), fact("Task", task.title ?? task.taskId));
    if (task.agent !== undefined) facts_.push(fact("Agent", task.agent.name));
  }
  if (record.agentId !== undefined) {
    const agent = await deps.store.get(record.orgId, record.agentId as never).catch(() => undefined);
    if (agent !== undefined) facts_.push(fact("Agent", agent.name));
  }
  const scopeWords = record.kind === "max_per_run" ? "This run's max per run" : record.kind === "planning" ? "This task's planning limit" : record.kind === "run_limit" ? "This task's run limit" : record.kind === "owner_cap" ? "One person's agent budgets" : "A monthly budget";
  facts_.push(fact("Raises", scopeWords), fact("Amount", dollars(record.amountUsd)));
  if (record.newLimitUsd !== undefined) facts_.push(fact("New limit", dollars(record.newLimitUsd)));
  facts_.push(fact("Expires", record.expiresAt));
  return { title: KIND_TITLES[record.kind], facts: facts_, paragraphs: [record.reason] };
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
    case "org": return;
  }
}

/**
 * `POST /v1/app/spend-requests` [member]: `{ requestId, kind: "month", scope, amountUsd, reason }`. One PENDING per month, scope and requester: asking again
 * answers the open one. R18: a repeat of the request answers what it first did. A scope with no limit can't be topped up (R47).
 */
async function askForMonth(deps: SpendRequestDependencies, caller: AgentCaller, value: unknown): Promise<StatusReply> {
  const parsed = AskMonthBodySchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "is not valid"}`);
  }
  const body = parsed.data;
  const scope = body.scope;
  await requireMayAsk(deps, caller, scope);
  const mark: RequestMark = {
    orgId: caller.orgId, developerId: caller.developerId, requestId: body.requestId,
    fingerprint: createHash("sha256").update(JSON.stringify(["spend-ask-month", scopeKey(scope), body.amountUsd, body.reason])).digest("hex"),
  };
  const earlier = await readRequest(deps, caller.orgId, caller.developerId, body.requestId);
  if (earlier !== undefined) {
    if (earlier.fingerprint !== mark.fingerprint) throw agentXError("CONFIG_INVALID", "requestId: this request ID was already used for a different request");
    return new StatusReply(201, earlier.result as object);
  }
  const month = iso(deps.now()).slice(0, 7);
  const limit = (await effectiveLimits(deps, { orgId: caller.orgId, month, scopes: [scope] })).get(scopeKey(scope));
  if (limit === undefined) throw agentXError("CONFIG_INVALID", "scope: that budget has no monthly limit to raise");
  const me = await resolveSurvivor(deps, caller.orgId, caller.developerId);
  const made = await createSpendRequest(deps, {
    orgId: caller.orgId, kind: "month", scope, subject: monthSubject(month, scope, me), amountUsd: body.amountUsd, newLimitUsd: cleanUsd(limit + body.amountUsd),
    requestedBy: { kind: "member", developerId: me }, reason: body.reason, request: mark,
    requestResult: (record) => ({ spendRequest: spendRequestView(deps, record) }),
  });
  return new StatusReply(made.created ? 201 : 200, { spendRequest: spendRequestView(deps, made.record) });
}

// ---- the routes

const SPEND_REQUESTS_PATH = /^\/v1\/app\/spend-requests(?:\/([^/]+)(?:\/(decide|confirm-link))?)?$/;
const CONTINUE_AS_TASK_PATH = /^\/v1\/app\/tasks\/([^/]+)\/continue-as-task$/;

export const isSpendRequestRoute = (pathname: string): boolean => SPEND_REQUESTS_PATH.test(pathname) || CONTINUE_AS_TASK_PATH.test(pathname);

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
  return task !== undefined && await resolveSurvivor(deps, caller.orgId, task.developerId) === me;
}

/**
 * The spend request routes:
 *   GET  /v1/app/spend-requests                   the open requests the caller may decide now
 *   GET  /v1/app/spend-requests/{id}               one request, to someone who may decide it, asked for it, or whose task it is (404 to anyone else)
 *   POST /v1/app/spend-requests/{id}/decide        through `requireDecide` only (R66): a token gets REAUTH_REQUIRED with the page's link
 *   POST /v1/app/spend-requests/{id}/confirm-link  the ticketed link for a person who may decide it now
 *   POST /v1/app/tasks/{id}/continue-as-task       [the task's owner] a test run that reached its cap goes on as a normal task
 */
export async function routeSpendRequests(deps: SpendRequestDependencies, caller: AgentCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const continued = CONTINUE_AS_TASK_PATH.exec(url.pathname);
  if (continued !== null) {
    if (request.method !== "POST") throw agentXError("NOT_FOUND", "route not found");
    if (deps.spendRequests?.continueAsTask === undefined) throw agentXError("NOT_FOUND", "that isn't available yet");
    return deps.spendRequests.continueAsTask(caller, decodeURIComponent(continued[1]!), jsonBody(request));
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
      if (mine || (await mayDecideNow(deps, caller, record)).allowed) shown.push(spendRequestView(deps, record));
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
    return { spendRequest: spendRequestView(deps, await visible()) };
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
