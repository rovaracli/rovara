// Plan 3 Task 28: a month's top-up. An admin adds dollars to one scope's limit for one UTC month (`TOPUP#<month>`); next month the
// limit is its base again. A top-up never gives a limit to a scope that has none (R47): no limit stays no limit.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { topUpKey, type BudgetScope } from "@agentx/cloud-contracts";
import { type OrgId } from "@rovara-code/contracts";

export interface TopUpDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
}

/** Subtraction and addition of cents leave float dust (29 + 0.1); a limit is never given more precision than a millionth of a dollar. */
export const cleanUsd = (amount: number): number => Number(amount.toFixed(6));

/** What was added to the scope's limit in the month, in US dollars: zero when nothing was, or the item does not read. */
export async function readTopUp(deps: TopUpDependencies, orgId: OrgId, month: string, scope: BudgetScope): Promise<number> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: topUpKey(orgId, month, scope), ConsistentRead: true })) as { Item?: { amountUsd?: unknown } };
  const amount = response.Item?.amountUsd;
  return typeof amount === "number" && Number.isFinite(amount) && amount > 0 ? amount : 0;
}

/** A base limit with the month's top-up added; an unset base stays unset. */
export const withTopUp = (base: number | undefined, topUpUsd: number): number | undefined => (base === undefined ? undefined : cleanUsd(base + topUpUsd));
