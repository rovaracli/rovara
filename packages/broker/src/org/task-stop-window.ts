import { PER_TASK_BUDGET_USD } from "@agentx/contracts";
import { AuditEventInputSchema } from "@agentx/contracts";
import { auditTaskStopDecision, auditOccurrence } from "../audit/events.js";
import { auditPendingItem } from "../audit/outbox.js";
import { createHash } from "node:crypto";
import { usdToWholeMicrodollars } from "./budget-amount.js";
import { requireNativeProjectWorkRole } from "../developer/task-access.js";
import { requireAgentAccess, type AgentAccessDeps } from "../agents/access.js";
import { taskStartProjectAuthorityChecks } from "./task-start-project-authority.js";
import { taskStartAgentAuthorityChecks } from "./task-start-agent-authority.js";
import { isDeepStrictEqual } from "node:util";
import { budgetActorChecks } from "../agents/budget-authority.js";
import { taskAccessFence } from "../developer/task-people.js";
import { ownerFenceOf, taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
// An accepted-operation receipt is durable replay evidence, never a free-standing
// permission to start paid work. The caller commits it with work and authority.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { orgMetaKey, orgMemberKey, projectMetaKey, SpendingAdmissionReferenceSchema, RunCheckoutSchema, WORK_ORIGINS, type WorkOrigin, SpendRequestIdSchema, OrgRoleSchema, type SpendingAdmissionReference, PayerSchema, PlaceSchema, AgentIdSchema, OrgIdSchema, TaskStopAdmissionInputSchema, TaskStopMicrousdSchema, agentXError, calculateTaskStop, orgScoped, type OrgId } from "@agentx/contracts";
import type { CapturedTaskStop } from "./task-stop-admission.js";
import type { TableInput, TransactItem } from "../agents/table-writes.js";
const sha = z.string().regex(/^[a-f0-9]{64}$/), revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const snapshotSchema = z.object({
  kind: z.literal("captured"), schemaVersion: z.literal(2), orgId: OrgIdSchema, project: z.string().min(1).max(256), agentId: AgentIdSchema,
  capturedAt: z.string().datetime(), policyDigest: sha, effectiveStopMicrousd: TaskStopMicrousdSchema, approvalCapMicrousd: TaskStopMicrousdSchema,
  bindingScopes: z.array(z.enum(["company_ceiling", "company_default", "project", "agent", "path", "approved_run", "approved_max_per_run", "committed_max_per_run", "requested", "chain", "testing"])).min(1),
  calculationInput: TaskStopAdmissionInputSchema,
  sourceRevisions: z.object({ company: revision, ceiling: revision, projectCatalog: revision, project: revision, agent: revision }).strict(),
}).strict().superRefine((value, context) => {
  const digest = createHash("sha256").update(JSON.stringify([value.orgId, value.project, value.agentId, value.sourceRevisions, value.calculationInput])).digest("hex");
  if (digest !== value.policyDigest) context.addIssue({ code: "custom", message: "Stored admission digest does not agree." });
  const result = calculateTaskStop(value.calculationInput);
  if (result.kind !== "resolved" || !("approvalCapMicrousd" in result) || result.effectiveStopMicrousd !== value.effectiveStopMicrousd
    || result.approvalCapMicrousd !== value.approvalCapMicrousd || JSON.stringify(result.bindingScopes) !== JSON.stringify(value.bindingScopes)) context.addIssue({ code: "custom", message: "Stored admission calculation does not agree." });
});
const invalid = () => agentXError("TASK_STOP_CONFIG_INVALID", "The saved spending admission could not be checked. Ask an admin to review Spending.");
export function checkedTaskStopSnapshot(value: unknown): CapturedTaskStop {
  const parsed = snapshotSchema.safeParse(value); if (!parsed.success) throw invalid(); return parsed.data;
}
/** Preserve accepted hard bounds; absent means no recorded bound, while a
 * corrupt present snapshot always refuses instead of becoming inheritance. */
export function savedTaskStopBounds(value: unknown): { requestedMicrousd?: number; chainMicrousd?: number; testingMicrousd?: number } {
  if (value === undefined) return {};
  const input = checkedTaskStopSnapshot(value).calculationInput;
  return { ...(input.requestedMicrousd === undefined ? {} : { requestedMicrousd: input.requestedMicrousd }),
    ...(input.chainMicrousd === undefined ? {} : { chainMicrousd: input.chainMicrousd }), ...(input.testingMicrousd === undefined ? {} : { testingMicrousd: input.testingMicrousd }) };
}
/** The exact numeric identity used when Continue opens a fresh window. */
export function continueAdmissionIdentity(task: Pick<DeveloperTaskRecord, "spendingStop" | "budgetUsd" | "maxPerRunUsd" | "requestedRunLimitUsd">) {
 const previous = task.spendingStop === undefined ? undefined : checkedTaskStopSnapshot(task.spendingStop).calculationInput;
 const requested = previous?.requestedMicrousd ?? (task.requestedRunLimitUsd === undefined ? undefined : usdToWholeMicrodollars(task.requestedRunLimitUsd));
 return {
  pathLimitMicrousd: previous?.approvedRunLimitMicrousd ?? previous?.pathLimitMicrousd ?? usdToWholeMicrodollars(task.budgetUsd ?? PER_TASK_BUDGET_USD) ?? null,
  ...(task.maxPerRunUsd === undefined ? {} : { committedMaxPerRunMicrousd: usdToWholeMicrodollars(task.maxPerRunUsd) ?? null }),
  ...(requested !== undefined ? { requestedMicrousd: requested } : task.requestedRunLimitUsd === undefined ? {} : { requestedMicrousd: null }),
  ...(previous?.chainMicrousd === undefined ? {} : { chainMicrousd: previous.chainMicrousd }),
  ...(previous?.testingMicrousd === undefined ? {} : { testingMicrousd: previous.testingMicrousd }),
 };
}
/** Task-specific consent persists independently of later agent inheritance. */
export function taskMaxPerRunForAdmission(admission: CapturedTaskStop): number | undefined {
  const input = admission.calculationInput;
  return input.approvedMaxPerRunMicrousd ?? input.committedMaxPerRunMicrousd
    ?? (input.agentStop.kind === "limited" ? Math.min(input.agentStop.stopMicrousd, admission.approvalCapMicrousd) : undefined);
}
/** A persisted task stop cannot be replaced by a missing or changed scalar. */
export function checkedTaskMaxPerRun(task: Pick<DeveloperTaskRecord, "maxPerRunUsd" | "spendingStop">): number | undefined {
  const actual = task.maxPerRunUsd === undefined ? undefined : usdToWholeMicrodollars(task.maxPerRunUsd);
  if (task.maxPerRunUsd !== undefined && actual === undefined) throw invalid();
  if (task.spendingStop !== undefined && taskMaxPerRunForAdmission(checkedTaskStopSnapshot(task.spendingStop)) !== actual) throw invalid();
  return actual;
}
const baselineUsdSchema = z.number().finite().nonnegative();
const receiptSchema = z.object({
  pk: z.string(), sk: z.string(), entityType: z.literal("SPENDING_ADMISSION"), version: z.literal(1), orgId: OrgIdSchema,
  workKind: z.literal("task-window"), workId: z.string().uuid(), requestId: z.string().uuid(), actorId: sha, intentHash: sha,
  budgetBaselineUsd: baselineUsdSchema, spendingStop: snapshotSchema, operationId: z.string().min(1).max(256), outcome: z.literal("accepted"), admittedAt: z.string().datetime(),
}).strict();
export interface TaskStopWindowIdentity { orgId: OrgId; taskId: string; requestId: string; actorId: string; intentHash: string; project: string; agentId: string }
export const taskStopWindowKey = (orgId: OrgId, taskId: string, requestId: string) => ({ pk: orgScoped(orgId, `SPENDING_ADMISSION#task-window#${taskId}`), sk: `REQUEST#${requestId}` });
export async function readTaskStopWindow(deps: Pick<TableInput, "documentClient" | "tableName">, input: TaskStopWindowIdentity): Promise<z.infer<typeof receiptSchema> | undefined> {
  const Key = taskStopWindowKey(input.orgId, input.taskId, input.requestId);
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key, ConsistentRead: true })) as { Item?: unknown };
  if (response.Item === undefined) return undefined;
  const parsed = receiptSchema.safeParse(response.Item); if (!parsed.success) throw invalid();
  const row = parsed.data;
  if (row.pk !== Key.pk || row.sk !== Key.sk || row.orgId !== input.orgId || row.workId !== input.taskId || row.requestId !== input.requestId
    || row.spendingStop.orgId !== input.orgId || row.spendingStop.project !== input.project || row.spendingStop.agentId !== input.agentId) throw invalid();
  if (row.actorId !== input.actorId || row.intentHash !== input.intentHash) throw agentXError("IDEMPOTENCY_CONFLICT", "This request ID already accepted a different spending window. Use a new request ID.");
  return row;
}
export function taskStopWindowItem(tableName: string, input: TaskStopWindowIdentity, snapshot: CapturedTaskStop, operationId: string, admittedAt: string, budgetBaselineUsd: number): TransactItem {
  const Item = receiptSchema.parse({ ...taskStopWindowKey(input.orgId, input.taskId, input.requestId), entityType: "SPENDING_ADMISSION", version: 1,
    orgId: input.orgId, workKind: "task-window", workId: input.taskId, requestId: input.requestId, actorId: input.actorId, intentHash: input.intentHash,
    budgetBaselineUsd, spendingStop: snapshot, operationId, outcome: "accepted", admittedAt });
  return { Put: { TableName: tableName, Item, ConditionExpression: "attribute_not_exists(pk)" } };
}

// A payer transition accepts a new window before its existing dispatcher is
// redriven. The original paused revision makes redrive safe after lost ACKs.
const transitionSchema = z.object({
  pk: z.string(), sk: z.string(), entityType: z.literal("SPENDING_ADMISSION"), version: z.literal(1), orgId: OrgIdSchema,
  workKind: z.literal("task-window"), workId: z.string().uuid(), requestId: z.string().uuid(), actorId: sha, intentHash: sha,
  actorRole: OrgRoleSchema, peopleRevision: revision.nullable(),
  firstDispatch: z.object({ operationId: z.string().uuid(), checkout: z.array(RunCheckoutSchema).optional(), readOnly: z.literal(true).optional() }).strict().nullable().optional(),
  origin: z.enum(WORK_ORIGINS).optional(), transitionKind: z.enum(["continue-as-task", "spend-approval"]), spendRequestId: SpendRequestIdSchema.optional(), spendingStop: snapshotSchema, payer: PayerSchema, place: PlaceSchema,
  budgetBaselineUsd: baselineUsdSchema, agentRunRevision: revision.nullable(), workflowRevision: revision.nullable(), outcome: z.literal("transitioned"), admittedAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if (value.transitionKind === "spend-approval" && (value.origin === undefined || value.firstDispatch === undefined)) context.addIssue({ code: "custom", message: "The approved origin is missing." });
  if ((value.transitionKind === "spend-approval") !== (value.spendRequestId !== undefined)) context.addIssue({ code: "custom", message: "Approval admission reference is missing or unexpected." });
});
export type TaskStopTransition = z.infer<typeof transitionSchema>;
export async function readTaskStopTransition(deps: Pick<TableInput, "documentClient" | "tableName">, input: TaskStopWindowIdentity): Promise<TaskStopTransition | undefined> {
  const Key = taskStopWindowKey(input.orgId, input.taskId, input.requestId);
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key, ConsistentRead: true })) as { Item?: unknown };
  if (response.Item === undefined) return undefined;
  const parsed = transitionSchema.safeParse(response.Item); if (!parsed.success) throw invalid();
  const row = parsed.data;
  if (row.pk !== Key.pk || row.sk !== Key.sk || row.orgId !== input.orgId || row.workId !== input.taskId || row.requestId !== input.requestId
    || row.spendingStop.orgId !== input.orgId || row.spendingStop.project !== input.project || row.spendingStop.agentId !== input.agentId || row.place.project !== input.project) throw invalid();
  if (row.actorId !== input.actorId || row.intentHash !== input.intentHash) throw agentXError("IDEMPOTENCY_CONFLICT", "This request ID already accepted a different spending transition. Use a new request ID.");
  return row;
}
export function taskStopTransitionItem(tableName: string, input: TaskStopWindowIdentity, value: Pick<TaskStopTransition, "spendingStop" | "budgetBaselineUsd" | "payer" | "place" | "agentRunRevision" | "workflowRevision" | "admittedAt" | "actorRole" | "peopleRevision"> & { transitionKind?: "spend-approval"; spendRequestId?: string; origin?: WorkOrigin; firstDispatch?: TaskStopTransition["firstDispatch"] }): TransactItem {
  const Item = transitionSchema.parse({ ...taskStopWindowKey(input.orgId, input.taskId, input.requestId), ...value,
    entityType: "SPENDING_ADMISSION", version: 1, orgId: input.orgId, workKind: "task-window", workId: input.taskId, requestId: input.requestId,
    actorId: input.actorId, intentHash: input.intentHash, transitionKind: value.transitionKind ?? "continue-as-task", outcome: "transitioned" });
  return { Put: { TableName: tableName, Item, ConditionExpression: "attribute_not_exists(pk)" } };
}

/** A newly accepted window in trusted dispatch extras supersedes the old task
 * window atomically. Multiple or unrelated receipts cannot select a binding. */
export function newTaskStopWindowReference(items: readonly TransactItem[], task: DeveloperTaskRecord): SpendingAdmissionReference | undefined {
  const receipts = items.filter(item => item.Put?.Item?.entityType === "SPENDING_ADMISSION");
  if (receipts.length === 0) return undefined;
  if (receipts.length !== 1) throw invalid();
  const parsed = z.union([receiptSchema, transitionSchema]).safeParse(receipts[0]?.Put?.Item);
  if (!parsed.success || task.orgId === undefined || task.agent === undefined) throw invalid();
  const row = parsed.data, Key = taskStopWindowKey(task.orgId, task.taskId, row.requestId);
  if (row.pk !== Key.pk || row.sk !== Key.sk || row.orgId !== task.orgId || row.workId !== task.taskId
    || row.spendingStop.orgId !== task.orgId || row.spendingStop.project !== task.project || row.spendingStop.agentId !== task.agent.agentId) throw invalid();
  return { requestId: row.requestId, actorId: row.actorId, intentHash: row.intentHash };
}

/** Validate persisted money context without recapturing current financial policy.
 * Native commit-time authority and operation binding remain the caller's job. */
export async function requireTaskStopWindowContext(deps: Pick<TableInput, "documentClient" | "tableName">, task: DeveloperTaskRecord): Promise<void> {
  if (task.spendingStop === undefined && task.spendingAdmission === undefined) return;
  const reference = SpendingAdmissionReferenceSchema.safeParse(task.spendingAdmission);
  if (!reference.success || task.orgId === undefined || task.agent === undefined || task.closedAt !== undefined) throw invalid();
  const snapshot = checkedTaskStopSnapshot(task.spendingStop);
  checkedTaskMaxPerRun(task);
  const Key = taskStopWindowKey(task.orgId, task.taskId, reference.data.requestId);
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key, ConsistentRead: true })) as { Item?: unknown };
  const parsed = z.union([receiptSchema, transitionSchema]).safeParse(response.Item);
  if (!parsed.success) throw invalid();
  const row = parsed.data;
  if (row.pk !== Key.pk || row.sk !== Key.sk || row.orgId !== task.orgId || row.workId !== task.taskId
    || row.requestId !== reference.data.requestId || row.actorId !== reference.data.actorId || row.intentHash !== reference.data.intentHash
    || snapshot.orgId !== task.orgId || snapshot.project !== task.project || snapshot.agentId !== task.agent.agentId
    || !isDeepStrictEqual(row.spendingStop, snapshot) || usdToWholeMicrodollars(task.budgetUsd) !== snapshot.effectiveStopMicrousd
    || (task.budgetBaselineUsd ?? 0) !== row.budgetBaselineUsd) throw invalid();
  if (row.outcome === "transitioned" && (!isDeepStrictEqual(task.payer, row.payer) || !isDeepStrictEqual(task.place, row.place)
    || task.origin !== (row.transitionKind === "continue-as-task" ? "app" : row.origin))) throw invalid();
}

/** Current owner and payer membership plus live project work authority.
 * Numeric spending policy is intentionally absent from these native fences. */
export async function taskStopKeyActorChecks(deps: Pick<TableInput, "documentClient" | "tableName">, task: DeveloperTaskRecord,
  ownerId: string, payerId?: string, access?: AgentAccessDeps): Promise<TransactItem[]> {
  if (task.orgId === undefined) throw invalid();
  const orgId = task.orgId;
  const read = async (Key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> => {
    const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
    return response.Item;
  };
  const org = await read(orgMetaKey(orgId));
  if (org?.orgId !== orgId || org.closingAt !== undefined || org.closedAt !== undefined) throw invalid();
  const checks: TransactItem[] = [];
  let ownerRole: z.infer<typeof OrgRoleSchema> | undefined;
  for (const developerId of new Set([ownerId, ...(payerId === undefined ? [] : [payerId])])) {
    const member = await read(orgMemberKey(orgId, developerId)), role = OrgRoleSchema.safeParse(member?.role);
    if (!role.success || member?.orgId !== orgId || member.developerId !== developerId) throw invalid();
    if (developerId === ownerId) ownerRole = role.data;
    const native = budgetActorChecks(deps.tableName, orgId, { developerId, role: role.data });
    checks.push(...(checks.length === 0 ? native : native.slice(0, 2)));
  }
  if (ownerRole === undefined) throw invalid();
  const actor = { orgId, developerId: ownerId, orgRole: ownerRole };
  checks.push(...await taskStartProjectAuthorityChecks(deps, { orgId, developerId: ownerId, role: ownerRole, project: task.project }, async () => {
    await requireNativeProjectWorkRole(deps, task, actor);
    const project = await read(projectMetaKey(orgId, task.project));
    if (project !== undefined && (project.status !== "active" || project.archivedAt !== undefined)) throw invalid();
  }));
  if (access === undefined || task.agent === undefined) throw invalid();
  const agentId = task.agent.agentId, draft = task.agent.version === "draft";
  checks.push(...await taskStartAgentAuthorityChecks(deps, { orgId, project: task.project, agentId, draft, frozenRecipe: true,
    process: task.agent.process === true, developerId: ownerId, role: ownerRole },
  () => requireAgentAccess(access, actor, agentId, draft ? "edit" : "use").then(() => undefined), () => access.store.listShares(orgId, agentId)));
  return checks;
}

/** Restores current native authority from an existing accepted window. No
 * current spending settings are read and no money is granted during recovery. */
export async function taskStopTransitionRecoveryChecks(deps: AgentAccessDeps, task: DeveloperTaskRecord, reference: SpendingAdmissionReference): Promise<TransactItem[]> {
  if (task.orgId === undefined || task.agent === undefined) throw invalid();
  const receipt = await readTaskStopTransition(deps, { orgId: task.orgId, taskId: task.taskId, requestId: reference.requestId, actorId: reference.actorId,
    intentHash: reference.intentHash, project: task.project, agentId: task.agent.agentId });
  if (receipt === undefined || task.origin !== (receipt.transitionKind === "spend-approval" ? receipt.origin : "app") || task.closedAt !== undefined || !isDeepStrictEqual(task.payer, receipt.payer)
    || !isDeepStrictEqual(task.spendingStop, receipt.spendingStop)
    || usdToWholeMicrodollars(task.budgetUsd) !== receipt.spendingStop.effectiveStopMicrousd) throw invalid();
  checkedTaskMaxPerRun(task);
  const actualBaseline = baselineUsdSchema.safeParse(task.budgetBaselineUsd === undefined ? 0 : task.budgetBaselineUsd);
  if (!actualBaseline.success || actualBaseline.data !== receipt.budgetBaselineUsd) throw invalid();
  if (receipt.transitionKind === "spend-approval" && receipt.firstDispatch != null && task.budgetPause?.firstDispatch !== undefined && !isDeepStrictEqual(task.budgetPause.firstDispatch, receipt.firstDispatch)) throw invalid();
  if (receipt.transitionKind === "spend-approval" && receipt.agentRunRevision === null && !isDeepStrictEqual(task.spendingAdmission, reference)) throw invalid();
  const actor = { orgId: task.orgId, developerId: receipt.actorId, orgRole: receipt.actorRole }, agentId = task.agent.agentId, draft = task.agent.version === "draft";
  const projectChecks = await taskStartProjectAuthorityChecks(deps, { orgId: task.orgId, developerId: actor.developerId, role: actor.orgRole, project: task.project },
    () => requireNativeProjectWorkRole(deps, task, actor));
  const agentChecks = await taskStartAgentAuthorityChecks(deps, { orgId: task.orgId, project: task.project, agentId, draft, frozenRecipe: true, process: task.agent.process === true, developerId: actor.developerId, role: actor.orgRole },
    () => requireAgentAccess(deps, actor, agentId, draft ? "edit" : "use").then(() => undefined), () => deps.store.listShares(actor.orgId, agentId));
  return [...budgetActorChecks(deps.tableName, task.orgId, { developerId: receipt.actorId, role: receipt.actorRole }),
    taskAccessFence(deps.tableName, task.taskId, receipt.peopleRevision ?? undefined), ...projectChecks, ...agentChecks];
}

const admittedTaskFields = ["orgId", "project", "agent", "payer", "origin", "developerId", "ownerKey", "share", "shareVersion", "startedBy", "place", "budgetUsd", "budgetBaselineUsd", "maxPerRunUsd", "spendingStop", "spendingAdmission", "budgetPause", "closedAt"] as const;
export async function admittedTaskSourceUnchanged(deps: Pick<TableInput, "documentClient" | "tableName">, task: DeveloperTaskRecord): Promise<boolean> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(task.taskId), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  if (response.Item === undefined) return false;
  try {
    return admittedTaskFields.every(field => isDeepStrictEqual(response.Item?.[field], task[field]))
      && isDeepStrictEqual(ownerFenceOf(response.Item as unknown as DeveloperTaskRecord), ownerFenceOf(task));
  } catch { return false; }
}
/** DynamoDB allows one action per key. Keep a task-notes update and the money
 * source condition on the same action rather than adding a duplicate key. */
export function withAdmittedTaskSource(tableName: string, task: DeveloperTaskRecord, input: readonly TransactItem[], prefix = "admitted"): { items: TransactItem[]; sourceIndex: number } {
  const Key = taskKey(task.taskId), names: Record<string, string> = {}, values: Record<string, unknown> = {};
  const owner = ownerFenceOf(task), tokens: Record<string, string> = {};
  for (const [token, field] of Object.entries(owner.names)) { const renamed = `#${prefix}_owner_${token.slice(1)}`; tokens[token] = renamed; names[renamed] = field; }
  for (const [token, value] of Object.entries(owner.values)) { const renamed = `:${prefix}_owner_${token.slice(1)}`; tokens[token] = renamed; values[renamed] = value; }
  const ownerCondition = owner.expression.replace(/[#:]\w+/gu, token => tokens[token] ?? token);
  const condition = admittedTaskFields.map(field => {
    const name = `#${prefix}_${field}`; names[name] = field;
    if (task[field] === undefined) return `attribute_not_exists(${name})`;
    const value = `:${prefix}_${field}`; values[value] = task[field]; return `${name} = ${value}`;
  }).join(" AND ") + ` AND (${ownerCondition})`;
  const items = [...input];
  const sourceIndex = items.findIndex(item => {
    const key = item.Update?.Key ?? item.ConditionCheck?.Key ?? item.Put?.Item ?? item.Delete?.Key;
    return key?.pk === Key.pk && key.sk === Key.sk;
  });
  const source = { ConditionExpression: condition, ExpressionAttributeNames: names, ExpressionAttributeValues: values };
  if (sourceIndex < 0) return { items: [...items, { ConditionCheck: { TableName: tableName, Key, ...source } }], sourceIndex: items.length };
  const existing = items[sourceIndex];
  const update = existing?.Update, check = existing?.ConditionCheck, action = update ?? check;
  if (action === undefined) throw invalid();
  if (Object.keys(names).some(name => action.ExpressionAttributeNames?.[name] !== undefined) || Object.keys(values).some(name => action.ExpressionAttributeValues?.[name] !== undefined)) throw invalid();
  const merged = { ...action, ConditionExpression: action.ConditionExpression === undefined ? condition : `(${action.ConditionExpression}) AND (${condition})`,
    ExpressionAttributeNames: { ...action.ExpressionAttributeNames, ...names }, ExpressionAttributeValues: { ...action.ExpressionAttributeValues, ...values } };
  items[sourceIndex] = update === undefined ? { ConditionCheck: { ...merged, ConditionExpression: merged.ConditionExpression } } : { Update: { ...update, ...merged } };
  return { items, sourceIndex };
}

export interface PreparedTaskApprovalAdmission {
  items: TransactItem[];
  authority: TransactItem[];
  reference: SpendingAdmissionReference;
  expectedPausedAgentRevision?: number;
  runSourceIndex?: number;
  receiptIndex: number;
  taskReference?: true;
  workflowRevision?: number;
}

/** The receipt and audit are one native write set; neither is optional runtime telemetry. */
export function taskStopAdmissionAuditItem(tableName: string, receipt: TransactItem): TransactItem {
 const row = z.union([receiptSchema, transitionSchema]).parse(receipt.Put?.Item);
 const event = AuditEventInputSchema.parse(auditTaskStopDecision({ action: "spending.stop_admitted", orgId: row.orgId, actor: { kind: "member", id: row.actorId },
  taskId: row.workId, admissionId: row.requestId, occurrence: auditOccurrence(row.workId, row.requestId), occurredAt: row.admittedAt,
  effectiveStopMicrousd: row.spendingStop.effectiveStopMicrousd, approvalCapMicrousd: row.spendingStop.approvalCapMicrousd, policyDigest: row.spendingStop.policyDigest }));
 return { Put: { TableName: tableName, Item: auditPendingItem(event, Date.parse(row.admittedAt)), ConditionExpression: "attribute_not_exists(pk)" } };
}
export function taskStopWindowItems(...args: Parameters<typeof taskStopWindowItem>): [TransactItem, TransactItem] {
 const receipt = taskStopWindowItem(...args); return [receipt, taskStopAdmissionAuditItem(args[0], receipt)];
}
export function taskStopTransitionItems(...args: Parameters<typeof taskStopTransitionItem>): [TransactItem, TransactItem] {
 const receipt = taskStopTransitionItem(...args); return [receipt, taskStopAdmissionAuditItem(args[0], receipt)];
}
