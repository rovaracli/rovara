import { z } from "zod";
import { agentXError, type SpendRequestRecord } from "@agentx/contracts";
import type { TransactItem } from "../agents/table-writes.js";
export type ApprovalSource = NonNullable<SpendRequestRecord["approvalSource"]>;
export const approvalFields = ["status", "owner", "accountable", "monthlyBudgetUsd", "maxPerRunUsd", "updatedAt", "updatedBy", "pinnedVersion", "revision"] as const;
export const ApprovalSourceSchema = z.object({
  version: z.literal(1), key: z.object({ pk: z.string().min(1), sk: z.string().min(1) }).strict(), exists: z.boolean(),
  fields: z.object({ status: z.enum(["active", "archived"]).optional(), owner: z.unknown().optional(), accountable: z.unknown().optional(), monthlyBudgetUsd: z.number().finite().nonnegative().optional(), maxPerRunUsd: z.number().finite().nonnegative().optional(), updatedAt: z.string().optional(), updatedBy: z.string().optional(), pinnedVersion: z.number().int().positive().optional(), revision: z.number().int().positive().optional() }).strict(),
}).strict().refine(source => source.exists || Object.keys(source.fields).length === 0);
export const staleApproval = () => agentXError("SPENDING_APPROVAL_STALE", "Spending figures changed; ask again.");
export function sourceFields(item: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(approvalFields.flatMap(field => item?.[field] === undefined ? [] : [[field, item[field]]]));
}
export function sourceCondition(source: ApprovalSource) {
  const names: Record<string, string> = { "#approvalSourcePk": "pk" };
  const values: Record<string, unknown> = {};
  const parts = [source.exists ? "attribute_exists(#approvalSourcePk)" : "attribute_not_exists(#approvalSourcePk)"];
  if (source.exists) approvalFields.forEach((field, index) => {
    const name = `#approvalSource${index}`, value = `:approvalSource${index}`;
    names[name] = field;
    if (Object.hasOwn(source.fields, field)) { values[value] = source.fields[field]; parts.push(`${name} = ${value}`); }
    else parts.push(`attribute_not_exists(${name})`);
  });
  return { ConditionExpression: parts.join(" AND "), ExpressionAttributeNames: names, ...(Object.keys(values).length === 0 ? {} : { ExpressionAttributeValues: values }) };
}
export function pinSourceWrite(items: TransactItem[], source: ApprovalSource): number {
  const index = items.findIndex(item => {
    const key = item.Update?.Key ?? item.Put?.Item;
    return key?.pk === source.key.pk && key.sk === source.key.sk;
  });
  const write = items[index]?.Update ?? items[index]?.Put;
  if (write === undefined) throw staleApproval();
  const condition = sourceCondition(source);
  if (Object.keys(write.ExpressionAttributeNames ?? {}).some(key => key.startsWith("#approvalSource")) || Object.keys(write.ExpressionAttributeValues ?? {}).some(key => key.startsWith(":approvalSource"))) throw staleApproval();
  write.ConditionExpression = `(${write.ConditionExpression ?? "attribute_exists(pk)"}) AND (${condition.ConditionExpression})`;
  write.ExpressionAttributeNames = { ...write.ExpressionAttributeNames, ...condition.ExpressionAttributeNames };
  if (condition.ExpressionAttributeValues !== undefined) write.ExpressionAttributeValues = { ...write.ExpressionAttributeValues, ...condition.ExpressionAttributeValues };
  return index;
}
