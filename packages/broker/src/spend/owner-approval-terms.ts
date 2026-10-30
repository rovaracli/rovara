import { nativeSnapshotConditions } from "../org/native-snapshot-conditions.js";
import { z } from "zod";
import { orgSettingsKey, ownerBudgetKey, topUpKey, type OrgId, type SpendRequestRecord } from "@agentx/contracts";
import type { TransactItem } from "../agents/table-writes.js";
import { staleApproval } from "./approval-source.js";
const amount = z.number().finite().nonnegative();
export const OwnerFinancialTermsSchema = z.object({ version: z.literal(1), basis: z.enum(["base", "effective"]).optional(), owner: z.string().regex(/^[a-f0-9]{64}$/), month: z.string().regex(/^\d{4}-\d{2}$/),
  totalUsd: amount, counterUsd: amount, counterVersion: z.number().int().nonnegative(), capUsd: amount, policyRevision: z.number().int().nonnegative(), carriedUsd: amount, wouldBeUsd: amount, carriedSource: z.object({ key: z.object({ pk: z.string().min(1), sk: z.string().min(1) }).strict(), exists: z.boolean(), fields: z.record(z.string(), z.unknown()) }).strict().optional() }).strict();
export type OwnerFinancialTerms = NonNullable<SpendRequestRecord["ownerFinancialTerms"]>;
export function assertOwnerCarriedSource(terms: { month: string; carriedSource?: OwnerFinancialTerms["carriedSource"] }, orgId: OrgId, context?: { agentId?: string; chainId?: string }): void {
  if (terms.carriedSource === undefined) return;
  if (context === undefined || (context.agentId === undefined && context.chainId === undefined)) throw staleApproval();
  const scope = context.chainId !== undefined ? { kind: "chain" as const, chainId: context.chainId } : { kind: "agent" as const, agentId: context.agentId! };
  const key = topUpKey(orgId, terms.month, scope);
  if (terms.carriedSource.key.pk !== key.pk || terms.carriedSource.key.sk !== key.sk) throw staleApproval();
}
/** One captured counter and policy, used at both creation and actual commit. */
export function ownerFinancialChecks(tableName: string, orgId: OrgId, terms: OwnerFinancialTerms, context?: { agentId?: string; chainId?: string }): TransactItem[] {
  if (!OwnerFinancialTermsSchema.safeParse(terms).success) throw staleApproval();
  assertOwnerCarriedSource(terms, orgId, context);
  const carried = terms.carriedSource;
  if (carried !== undefined && (carried.exists ? carried.fields.amountUsd !== terms.carriedUsd : terms.carriedUsd !== 0 || Object.keys(carried.fields).length !== 0)) throw staleApproval();
  return [
    { ConditionCheck: { TableName: tableName, Key: ownerBudgetKey(orgId, terms.owner),
      ConditionExpression: `#approvalTotal = :approvalTotal AND ${terms.counterVersion === 0 ? "(attribute_not_exists(#approvalVersion) OR #approvalVersion = :approvalVersion)" : "#approvalVersion = :approvalVersion"}`,
      ExpressionAttributeNames: { "#approvalTotal": "totalUsd", "#approvalVersion": "version" }, ExpressionAttributeValues: { ":approvalTotal": terms.counterUsd, ":approvalVersion": terms.counterVersion } } },
    { ConditionCheck: { TableName: tableName, Key: orgSettingsKey(orgId, "SPEND_POLICY"), ...(terms.policyRevision === 0 ? { ConditionExpression: "attribute_not_exists(pk)" }
      : { ConditionExpression: "#approvalPolicyRevision = :approvalPolicyRevision AND #approvalPolicyCap = :approvalPolicyCap", ExpressionAttributeNames: { "#approvalPolicyRevision": "revision", "#approvalPolicyCap": "ownerAgentBudgetCapUsd" }, ExpressionAttributeValues: { ":approvalPolicyRevision": terms.policyRevision, ":approvalPolicyCap": terms.capUsd } }) } },
    ...(carried === undefined ? [] : nativeSnapshotConditions(tableName, [carried.key], [carried.exists ? carried.fields : undefined], ["amountUsd"])),
  ];
}
/** Merge the captured counter into the store's existing update: DynamoDB allows one action per key. */
export function pinOwnerFinancialChecks(items: TransactItem[], checks: TransactItem[]): number[] {
  return checks.map(item => {
    const check = item.ConditionCheck;
    if (check === undefined) throw staleApproval();
    const index = items.findIndex(candidate => candidate.Update?.Key?.pk === check.Key?.pk && candidate.Update?.Key?.sk === check.Key?.sk);
    if (index < 0) { items.push(item); return items.length - 1; }
    const update = items[index]!.Update!;
    update.ConditionExpression = `(${update.ConditionExpression ?? "attribute_exists(pk)"}) AND (${check.ConditionExpression})`;
    update.ExpressionAttributeNames = { ...update.ExpressionAttributeNames, ...check.ExpressionAttributeNames };
    update.ExpressionAttributeValues = { ...update.ExpressionAttributeValues, ...check.ExpressionAttributeValues };
    return index;
  });
}
