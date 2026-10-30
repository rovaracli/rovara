// An accepted-operation receipt is durable replay evidence, never a free-standing
// permission to start paid work. The caller commits it with work and authority.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentIdSchema, OrgIdSchema, TaskStopAdmissionInputSchema, TaskStopMicrousdSchema, agentXError, calculateTaskStop, orgScoped, type OrgId } from "@agentx/contracts";
import type { CapturedTaskStop } from "./task-stop-admission.js";
import type { TableInput, TransactItem } from "../agents/table-writes.js";
const sha = z.string().regex(/^[a-f0-9]{64}$/), revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const snapshotSchema = z.object({
  kind: z.literal("captured"), schemaVersion: z.literal(2), orgId: OrgIdSchema, project: z.string().min(1).max(256), agentId: AgentIdSchema,
  capturedAt: z.string().datetime(), policyDigest: sha, effectiveStopMicrousd: TaskStopMicrousdSchema, approvalCapMicrousd: TaskStopMicrousdSchema,
  bindingScopes: z.array(z.enum(["company_ceiling", "company_default", "project", "agent", "path", "approved_run", "requested", "chain", "testing"])).min(1),
  calculationInput: TaskStopAdmissionInputSchema,
  sourceRevisions: z.object({ company: revision, ceiling: revision, projectCatalog: revision, project: revision, agent: revision }).strict(),
}).strict().superRefine((value, context) => {
  const result = calculateTaskStop(value.calculationInput);
  if (result.kind !== "resolved" || !("approvalCapMicrousd" in result) || result.effectiveStopMicrousd !== value.effectiveStopMicrousd
    || result.approvalCapMicrousd !== value.approvalCapMicrousd || JSON.stringify(result.bindingScopes) !== JSON.stringify(value.bindingScopes)) context.addIssue({ code: "custom", message: "Stored admission calculation does not agree." });
});
const invalid = () => agentXError("TASK_STOP_CONFIG_INVALID", "The saved spending admission could not be checked. Ask an admin to review Spending.");
export function checkedTaskStopSnapshot(value: unknown): CapturedTaskStop {
  const parsed = snapshotSchema.safeParse(value); if (!parsed.success) throw invalid(); return parsed.data;
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
