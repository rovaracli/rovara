import { checkedTaskMaxPerRun } from "../org/task-stop-window.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { TaskStopAdmissionInputSchema, RunCheckoutSchema, PER_TASK_BUDGET_USD, spendRequestKey, agentXError, type SpendRequestRecord } from "@agentx/contracts";
import { taskKey, tryEffectiveTaskOwner, type DeveloperTaskRecord } from "../developer/task-records.js";
import type { CapturedTaskStop } from "../org/task-stop-admission.js";
import { usdToWholeMicrodollars } from "../org/budget-amount.js";
import type { TransactItem } from "../agents/table-writes.js";
const fields = ["orgId", "project", "agent", "payer", "origin", "developerId", "ownerKey", "startedBy", "place", "budgetUsd", "maxPerRunUsd", "budgetBaselineUsd", "spendingStop", "closedAt"] as const;
export function taskApprovalFields(task: DeveloperTaskRecord): Record<string, unknown> {
  return Object.fromEntries(fields.flatMap(field => task[field] === undefined ? [] : [[field, task[field]]]));
}
/** The already accepted run basis is distinct from a smaller enforced cap. */
export function taskRunLimitMicrousd(task: { spendingStop?: unknown; budgetUsd?: unknown }): number | undefined {
  if (task.spendingStop === undefined) return usdToWholeMicrodollars(task.budgetUsd === undefined ? PER_TASK_BUDGET_USD : task.budgetUsd);
  const saved = z.object({ calculationInput: TaskStopAdmissionInputSchema }).safeParse(task.spendingStop);
  return saved.success ? saved.data.calculationInput.approvedRunLimitMicrousd ?? saved.data.calculationInput.pathLimitMicrousd : undefined;
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : typeof value === "object" && value !== null
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const micros = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), sha = z.string().regex(/^[a-f0-9]{64}$/);
export const TaskApprovalTermsSchema = z.object({
  version: z.literal(1), sourcePresence: z.literal(true), sourceKey: z.object({ pk: z.string(), sk: z.literal("META") }).strict(),
  sourceRevision: z.string().datetime().nullable(), sourceDigest: sha,
  firstDispatch: z.object({ operationId: z.string().uuid(), checkout: z.array(RunCheckoutSchema).optional(), readOnly: z.literal(true).optional() }).strict().nullable(),
  originalFields: z.record(z.string(), z.unknown()).refine(value => Object.keys(value).every(key => fields.some(field => field === key))),
  askedFiguresMicrousd: z.object({ budget: micros, runLimit: micros, amount: micros, maxPerRun: micros.nullable(), baseline: micros }).strict(), proposedFiguresMicrousd: z.object({ budget: micros, runLimit: micros, maxPerRun: micros.nullable(), window: z.enum(["keep", "reset"]) }).strict(),
  countedOwner: sha.nullable(), totalsRevision: z.null(), policyDigest: sha, admissionId: z.string().min(1).max(256), operation: z.enum(["run_limit", "max_per_run", "planning"]),
}).strict().superRefine((value, context) => {
  if (digest({ originalFields: value.originalFields, firstDispatch: value.firstDispatch }) !== value.sourceDigest) context.addIssue({ code: "custom", message: "Original source digest does not agree." });
  const fields = value.originalFields, asked = value.askedFiguresMicrousd, proposed = value.proposedFiguresMicrousd;
  if (asked.runLimit !== taskRunLimitMicrousd(fields) || asked.budget !== usdToWholeMicrodollars(fields.budgetUsd === undefined ? PER_TASK_BUDGET_USD : fields.budgetUsd)
    || asked.baseline !== usdToWholeMicrodollars(fields.budgetBaselineUsd === undefined ? 0 : fields.budgetBaselineUsd)
    || asked.maxPerRun !== (fields.maxPerRunUsd === undefined ? null : usdToWholeMicrodollars(fields.maxPerRunUsd))) context.addIssue({ code: "custom", message: "Asked figures do not agree with the original source." });
  if (value.operation === "max_per_run" ? proposed.runLimit !== asked.runLimit || proposed.maxPerRun === null || proposed.budget !== Math.min(asked.runLimit, proposed.maxPerRun) || proposed.window !== "keep" : proposed.budget !== Math.min(proposed.runLimit, asked.maxPerRun ?? proposed.runLimit) || proposed.maxPerRun !== asked.maxPerRun) context.addIssue({ code: "custom", message: "The proposed figures change another spending limit." });
});
export type TaskApprovalTerms = z.infer<typeof TaskApprovalTermsSchema>;
/** Financial policy evidence excludes path/approved/request amounts, which are
 * separate pinned terms. It never reads a newer policy during a transaction. */
export function taskApprovalPolicyDigest(snapshot: CapturedTaskStop): string {
  const input = snapshot.calculationInput;
  return digest([snapshot.sourceRevisions, input.companyDefault, input.ceilingMicrousd, input.projectStop, input.agentStop]);
}
export function makeTaskApprovalTerms(task: DeveloperTaskRecord, snapshot: CapturedTaskStop, record: SpendRequestRecord): TaskApprovalTerms {
  checkedTaskMaxPerRun(task);
  const originalFields = taskApprovalFields(task), firstDispatch = task.budgetPause?.firstDispatch ?? null, runLimit = taskRunLimitMicrousd(task), proposed = usdToWholeMicrodollars(record.newLimitUsd ?? record.amountUsd);
  return TaskApprovalTermsSchema.parse({ version: 1, sourcePresence: true, sourceKey: taskKey(task.taskId), sourceRevision: task.spendingStop?.capturedAt ?? null,
    sourceDigest: digest({ originalFields, firstDispatch }), originalFields, firstDispatch,
    askedFiguresMicrousd: { budget: usdToWholeMicrodollars(task.budgetUsd ?? PER_TASK_BUDGET_USD), runLimit, amount: usdToWholeMicrodollars(record.amountUsd),
      maxPerRun: task.maxPerRunUsd === undefined ? null : usdToWholeMicrodollars(task.maxPerRunUsd), baseline: usdToWholeMicrodollars(task.budgetBaselineUsd ?? 0) },
    proposedFiguresMicrousd: { budget: record.kind === "max_per_run" ? Math.min(runLimit ?? NaN, proposed ?? NaN) : Math.min(proposed ?? NaN, task.maxPerRunUsd === undefined ? proposed ?? NaN : usdToWholeMicrodollars(task.maxPerRunUsd) ?? NaN), runLimit: record.kind === "max_per_run" ? runLimit : proposed,
      maxPerRun: record.kind === "max_per_run" ? usdToWholeMicrodollars(record.newLimitUsd ?? record.amountUsd) : task.maxPerRunUsd === undefined ? null : usdToWholeMicrodollars(task.maxPerRunUsd),
      window: record.kind === "planning" || record.resume === "implement" ? "reset" : "keep" },
    countedOwner: tryEffectiveTaskOwner(task)?.developerId ?? null, totalsRevision: null, policyDigest: taskApprovalPolicyDigest(snapshot),
    admissionId: `task:${task.taskId}:${task.spendingStop?.capturedAt ?? "existing"}`, operation: record.kind });
}
export const taskApprovalSourceMatches = (terms: TaskApprovalTerms, task: DeveloperTaskRecord): boolean => terms.sourceKey.pk === taskKey(task.taskId).pk && digest({ originalFields: taskApprovalFields(task), firstDispatch: task.budgetPause?.firstDispatch ?? null }) === terms.sourceDigest;
export function taskApprovalRecordMatches(terms: TaskApprovalTerms, record: SpendRequestRecord): boolean {
  return terms.operation === record.kind && terms.askedFiguresMicrousd.amount === usdToWholeMicrodollars(record.amountUsd)
    && (record.kind === "max_per_run" ? terms.proposedFiguresMicrousd.maxPerRun : terms.proposedFiguresMicrousd.runLimit) === usdToWholeMicrodollars(record.newLimitUsd ?? record.amountUsd)
    && terms.proposedFiguresMicrousd.window === (record.kind === "planning" || record.resume === "implement" ? "reset" : "keep");
}
/** Merge the original source into the request's existing task write, or append
 * one condition when it has none. Never duplicate a DynamoDB key. */
export function pinTaskApprovalSource(tableName: string, items: TransactItem[], terms: TaskApprovalTerms): number {
  const names: Record<string, string> = { "#askedPause": "budgetPause", "#askedFirstDispatch": "firstDispatch" }, values: Record<string, unknown> = {};
  const firstDispatchCondition = terms.firstDispatch === null ? "attribute_not_exists(#askedPause.#askedFirstDispatch)" : "#askedPause.#askedFirstDispatch = :askedFirstDispatch";
  if (terms.firstDispatch !== null) values[":askedFirstDispatch"] = terms.firstDispatch;
  const condition = ["attribute_exists(pk)", firstDispatchCondition, ...fields.map(field => {
    const name = `#askedTask_${field}`; names[name] = field;
    if (!Object.hasOwn(terms.originalFields, field)) return `attribute_not_exists(${name})`;
    const value = `:askedTask_${field}`; values[value] = terms.originalFields[field]; return `${name} = ${value}`;
  })].join(" AND ");
  const index = items.findIndex(item => { const key = item.Update?.Key ?? item.ConditionCheck?.Key ?? item.Put?.Item ?? item.Delete?.Key; return key?.pk === terms.sourceKey.pk && key.sk === terms.sourceKey.sk; });
  if (index < 0) { items.push({ ConditionCheck: { TableName: tableName, Key: terms.sourceKey,
    ConditionExpression: condition, ExpressionAttributeNames: names, ExpressionAttributeValues: values } }); return items.length - 1; }
  const action = items[index]?.Update ?? items[index]?.ConditionCheck;
  if (action === undefined || Object.keys(names).some(key => action.ExpressionAttributeNames?.[key] !== undefined)) throw agentXError("SPENDING_APPROVAL_STALE", "Spending figures changed; ask again.");
  action.ConditionExpression = `(${action.ConditionExpression ?? "attribute_exists(pk)"}) AND (${condition})`;
  action.ExpressionAttributeNames = { ...action.ExpressionAttributeNames, ...names }; action.ExpressionAttributeValues = { ...action.ExpressionAttributeValues, ...values };
  return index;
}

/** Request terms themselves are part of what the actual decider approved. */
export function pinTaskApprovalRequest(items: TransactItem[], record: SpendRequestRecord): number {
  const key = spendRequestKey(record.orgId, record.spendRequestId);
  const index = items.findIndex(item => item.Update?.Key?.pk === key.pk && item.Update.Key.sk === key.sk), action = items[index]?.Update;
  if (action === undefined) throw agentXError("SPENDING_APPROVAL_STALE", "Spending figures changed; ask again.");
  const names: Record<string, string> = {}, values: Record<string, unknown> = {};
  const clauses = (["orgId", "spendRequestId", "kind", "scope", "taskId", "agentId", "chainId", "amountUsd", "newLimitUsd", "requestedBy", "requestedFor", "resume", "approvalTerms", "change", "newOwner", "forOwner"] as const).map(field => {
    const name = `#askedRequest_${field}`; names[name] = field;
    if (record[field] === undefined) return `attribute_not_exists(${name})`;
    const value = `:askedRequest_${field}`; values[value] = record[field]; return `${name} = ${value}`;
  });
  action.ConditionExpression = `(${action.ConditionExpression ?? "attribute_exists(pk)"}) AND (${clauses.join(" AND ")})`;
  action.ExpressionAttributeNames = { ...action.ExpressionAttributeNames, ...names }; action.ExpressionAttributeValues = { ...action.ExpressionAttributeValues, ...values };
  return index;
}
