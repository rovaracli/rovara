// Unexposed company-close prerequisite. Lane A must separately wire this before final close;
// this module does not release a route, company-close behavior, or working-branch consumers.
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentXError, OrgIdSchema, agentXError, orgMetaKey, orgScoped } from "@agentx/contracts";
import type { DeveloperRouteDependencies } from "../aws/developer-routes.js";
import type { TransactItem } from "../audit/outbox.js";
type Deps = Pick<DeveloperRouteDependencies, "documentClient" | "tableName">;
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Working branch receipts could not be cleared. Retry company cleanup.");
const stale = () => agentXError("CHANGE_STALE", "Company cleanup authority changed. Retry company cleanup.");
const stamp = z.string().datetime();
/** Each page commits independently. A failed/ambiguous call is never resent here; a fresh call
 * reads what remains. `deleted` counts receipt keys confirmed absent by this invocation, not a
 * global count across concurrent cleanup callers. Active-company idempotency has no expiry. */
export async function clearWorkingBranchSaveReceipts(deps: Deps, value: unknown): Promise<{ deleted: number }> {
 const parsed = OrgIdSchema.safeParse(value);
 if (!parsed.success) throw agentXError("CONFIG_INVALID", "Choose a valid company for receipt cleanup.");
 const orgId = parsed.data, pk = orgScoped(orgId, "REVIEWED_WORKING_BRANCH"), metaKey = orgMetaKey(orgId);
 try {
  const { Item: org } = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: metaKey, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  if (org?.orgId !== orgId || (org.closingAt === undefined && org.closedAt === undefined)
   || (org.closingAt !== undefined && !stamp.safeParse(org.closingAt).success)
   || (org.closedAt !== undefined && !stamp.safeParse(org.closedAt).success)) {
   throw agentXError("FORBIDDEN", "Working branch receipts can be cleared only while this company is closing or closed.");
  }
  const conditions = ["orgId = :org"], values: Record<string, unknown> = { ":org": orgId };
  for (const field of ["closingAt", "closedAt"] as const) {
   if (org[field] === undefined) conditions.push(`attribute_not_exists(${field})`);
   else { conditions.push(`${field} = :${field}`); values[`:${field}`] = org[field]; }
  }
  const cursorSchema = z.object({ pk: z.literal(pk), sk: z.string().uuid() }).strict();
  const receiptSchema = z.object({ pk: z.literal(pk), sk: z.string().uuid(), orgId: z.literal(orgId), entityType: z.literal("REVIEWED_WORKING_BRANCH_REQUEST") }).passthrough();
  let cursor: { pk: string; sk: string } | undefined, deleted = 0;
  const seen = new Set<string>();
  for (let page = 0; page < 100; page += 1) {
   const result = await deps.documentClient.send(new QueryCommand({ TableName: deps.tableName, KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": pk }, ConsistentRead: true, Limit: 25, ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }) })) as { Items?: unknown[]; LastEvaluatedKey?: unknown };
   const rows = result.Items ?? [];
   if (!Array.isArray(rows) || rows.length > 25) throw unavailable();
   const keys = rows.map(row => { const receipt = receiptSchema.safeParse(row); if (!receipt.success) throw unavailable(); return { pk, sk: receipt.data.sk }; });
   if (new Set(keys.map(key => key.sk)).size !== keys.length) throw unavailable();
   let next: { pk: string; sk: string } | undefined;
   if (result.LastEvaluatedKey !== undefined) {
    const checked = cursorSchema.safeParse(result.LastEvaluatedKey);
    if (!checked.success || seen.has(checked.data.sk)) throw unavailable();
    next = checked.data; seen.add(next.sk);
   }
   if (keys.length > 0) {
    const items: TransactItem[] = [{ ConditionCheck: { TableName: deps.tableName, Key: metaKey, ConditionExpression: conditions.join(" AND "), ExpressionAttributeValues: values } },
     ...keys.map(Key => ({ Delete: { TableName: deps.tableName, Key,
      ConditionExpression: "attribute_not_exists(pk) OR (orgId = :org AND entityType = :type)",
      ExpressionAttributeValues: { ":org": orgId, ":type": "REVIEWED_WORKING_BRANCH_REQUEST" } } }))];
    try { await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items })); }
    catch (error) {
     if (error instanceof Error && error.name === "TransactionCanceledException") {
      const reasons = (error as { CancellationReasons?: unknown }).CancellationReasons;
      // Item zero is the org lifecycle fence; receipt conditions and conflicts do not prove authority changed.
      const first = Array.isArray(reasons) ? reasons[0] as { Code?: unknown } | null | undefined : undefined;
      if (first?.Code === "ConditionalCheckFailed") throw stale();
     }
     throw unavailable();
    }
    deleted += keys.length;
   }
   if (next === undefined) return { deleted };
   cursor = next;
  }
  // Successful earlier pages remain erased. Restarting after this bounded refusal makes progress.
  throw unavailable();
 } catch (error) {
  if (error instanceof AgentXError) throw error;
  throw unavailable();
 }
}
