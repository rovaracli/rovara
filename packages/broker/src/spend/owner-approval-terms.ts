import { z } from "zod";
import { orgSettingsKey, ownerBudgetKey, type OrgId, type SpendRequestRecord } from "@agentx/contracts";
import type { TransactItem } from "../agents/table-writes.js";
import { staleApproval } from "./approval-source.js";
const amount = z.number().finite().nonnegative();
export const OwnerFinancialTermsSchema = z.object({ version: z.literal(1), basis: z.enum(["base", "effective"]).optional(), owner: z.string().regex(/^[a-f0-9]{64}$/), month: z.string().regex(/^\d{4}-\d{2}$/),
  totalUsd: amount, counterUsd: amount, counterVersion: z.number().int().nonnegative(), capUsd: amount, policyRevision: z.number().int().nonnegative(), carriedUsd: amount, wouldBeUsd: amount }).strict();
export type OwnerFinancialTerms = NonNullable<SpendRequestRecord["ownerFinancialTerms"]>;
/** One captured counter and policy, used at both creation and actual commit. */
export function ownerFinancialChecks(tableName: string, orgId: OrgId, terms: OwnerFinancialTerms): TransactItem[] {
  if (!OwnerFinancialTermsSchema.safeParse(terms).success) throw staleApproval();
  return [
    { ConditionCheck: { TableName: tableName, Key: ownerBudgetKey(orgId, terms.owner),
      ConditionExpression: `#approvalTotal = :approvalTotal AND ${terms.counterVersion === 0 ? "(attribute_not_exists(#approvalVersion) OR #approvalVersion = :approvalVersion)" : "#approvalVersion = :approvalVersion"}`,
      ExpressionAttributeNames: { "#approvalTotal": "totalUsd", "#approvalVersion": "version" }, ExpressionAttributeValues: { ":approvalTotal": terms.counterUsd, ":approvalVersion": terms.counterVersion } } },
    { ConditionCheck: { TableName: tableName, Key: orgSettingsKey(orgId, "SPEND_POLICY"), ...(terms.policyRevision === 0 ? { ConditionExpression: "attribute_not_exists(pk)" }
      : { ConditionExpression: "#approvalPolicyRevision = :approvalPolicyRevision AND #approvalPolicyCap = :approvalPolicyCap", ExpressionAttributeNames: { "#approvalPolicyRevision": "revision", "#approvalPolicyCap": "ownerAgentBudgetCapUsd" }, ExpressionAttributeValues: { ":approvalPolicyRevision": terms.policyRevision, ":approvalPolicyCap": terms.capUsd } }) } },
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
