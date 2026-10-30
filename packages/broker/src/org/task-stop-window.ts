import { createHash } from "node:crypto";
import { usdToWholeMicrodollars } from "./budget-amount.js";
import { requireNativeProjectWorkRole } from "../developer/task-access.js";
import { requireAgentAccess, type AgentAccessDeps } from "../agents/access.js";
import { taskStartProjectAuthorityChecks } from "./task-start-project-authority.js";
import { taskStartAgentAuthorityChecks } from "./task-start-agent-authority.js";
import { isDeepStrictEqual } from "node:util";
import { budgetActorChecks } from "../agents/budget-authority.js";
import { taskAccessFence } from "../developer/task-people.js";
import { taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
// An accepted-operation receipt is durable replay evidence, never a free-standing
// permission to start paid work. The caller commits it with work and authority.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { RunCheckoutSchema, WORK_ORIGINS, type WorkOrigin, SpendRequestIdSchema, OrgRoleSchema, type SpendingAdmissionReference, PayerSchema, PlaceSchema, AgentIdSchema, OrgIdSchema, TaskStopAdmissionInputSchema, TaskStopMicrousdSchema, agentXError, calculateTaskStop, orgScoped, type OrgId } from "@agentx/contracts";
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
/** Task-specific consent persists independently of later agent inheritance. */
export function taskMaxPerRunForAdmission(admission: CapturedTaskStop): number | undefined {
  const input = admission.calculationInput;
  return input.approvedMaxPerRunMicrousd ?? input.committedMaxPerRunMicrousd
    ?? (input.agentStop.kind === "limited" ? Math.min(input.agentStop.stopMicrousd, admission.approvalCapMicrousd) : undefined);
}
const receiptSchema = z.object({
  pk: z.string(), sk: z.string(), entityType: z.literal("SPENDING_ADMISSION"), version: z.literal(1), orgId: OrgIdSchema,
  workKind: z.literal("task-window"), workId: z.string().uuid(), requestId: z.string().uuid(), actorId: sha, intentHash: sha,
  spendingStop: snapshotSchema, operationId: z.string().min(1).max(256), outcome: z.literal("accepted"), admittedAt: z.string().datetime(),
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
export function taskStopWindowItem(tableName: string, input: TaskStopWindowIdentity, snapshot: CapturedTaskStop, operationId: string, admittedAt: string): TransactItem {
  const Item = receiptSchema.parse({ ...taskStopWindowKey(input.orgId, input.taskId, input.requestId), entityType: "SPENDING_ADMISSION", version: 1,
    orgId: input.orgId, workKind: "task-window", workId: input.taskId, requestId: input.requestId, actorId: input.actorId, intentHash: input.intentHash,
    spendingStop: snapshot, operationId, outcome: "accepted", admittedAt });
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
  agentRunRevision: revision.nullable(), workflowRevision: revision.nullable(), outcome: z.literal("transitioned"), admittedAt: z.string().datetime(),
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
export function taskStopTransitionItem(tableName: string, input: TaskStopWindowIdentity, value: Pick<TaskStopTransition, "spendingStop" | "payer" | "place" | "agentRunRevision" | "workflowRevision" | "admittedAt" | "actorRole" | "peopleRevision"> & { transitionKind?: "spend-approval"; spendRequestId?: string; origin?: WorkOrigin; firstDispatch?: TaskStopTransition["firstDispatch"] }): TransactItem {
  const Item = transitionSchema.parse({ ...taskStopWindowKey(input.orgId, input.taskId, input.requestId), ...value,
    entityType: "SPENDING_ADMISSION", version: 1, orgId: input.orgId, workKind: "task-window", workId: input.taskId, requestId: input.requestId,
    actorId: input.actorId, intentHash: input.intentHash, transitionKind: value.transitionKind ?? "continue-as-task", outcome: "transitioned" });
  return { Put: { TableName: tableName, Item, ConditionExpression: "attribute_not_exists(pk)" } };
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

const admittedTaskFields = ["orgId", "project", "agent", "payer", "origin", "developerId", "ownerKey", "startedBy", "place", "budgetUsd", "budgetBaselineUsd", "maxPerRunUsd", "spendingStop", "spendingAdmission", "budgetPause", "closedAt"] as const;
export async function admittedTaskSourceUnchanged(deps: Pick<TableInput, "documentClient" | "tableName">, task: DeveloperTaskRecord): Promise<boolean> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(task.taskId), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  return response.Item !== undefined && admittedTaskFields.every(field => isDeepStrictEqual(response.Item?.[field], task[field]));
}
/** DynamoDB allows one action per key. Keep a task-notes update and the money
 * source condition on the same action rather than adding a duplicate key. */
export function withAdmittedTaskSource(tableName: string, task: DeveloperTaskRecord, input: readonly TransactItem[]): { items: TransactItem[]; sourceIndex: number } {
  const Key = taskKey(task.taskId), names: Record<string, string> = {}, values: Record<string, unknown> = {};
  const condition = admittedTaskFields.map(field => {
    const name = `#admitted_${field}`; names[name] = field;
    if (task[field] === undefined) return `attribute_not_exists(${name})`;
    const value = `:admitted_${field}`; values[value] = task[field]; return `${name} = ${value}`;
  }).join(" AND ");
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
