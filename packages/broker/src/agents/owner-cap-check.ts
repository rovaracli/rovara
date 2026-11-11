// Task 28 and Task 33 (fix rounds 1 and 2), moved out of routes.ts so the agent publish requests' approval (agents/publication.ts) holds a move of ownership to the same
// cap a `PUT owner` is held to: whether moving an agent's (or a chain's) monthly budget from `before` to `after` keeps the new owner's effective total within the cap, with
// the month's top-up carried to an owner it newly counts for. Reads only; the write is held to the answer's `ownerCap` inside its own transaction.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { topUpKey, type BudgetScope } from "@agentx/cloud-contracts";
import { agentXError, type AgentId, type ChainId, type OrgId } from "@rovara-code/contracts";
import { usdToWholeMicrodollars } from "../org/budget-amount.js";
import type { OwnerFinancialTerms } from "../spend/owner-approval-terms.js";
import { ownerShare } from "../spend/owner-total.js";
import { effectiveOwnerCap, type SpendRequestDependencies } from "../spend/requests.js";
import { ownerBudgetRefusal } from "../spend/settings.js";
import { resolveSurvivor } from "./access.js";

export type OwnerCapAnswer = Awaited<ReturnType<typeof ownerBudgetRefusal>>;

/** `{ over }` when the move would take the new owner past the cap (with the figures an admin is asked about), else `{ ownerCap }` for the write. */
export async function ownerCapCheck(
  deps: SpendRequestDependencies, orgId: OrgId, subject: { kind: "agent"; agentId: AgentId } | { kind: "chain"; chainId: ChainId },
  before: Parameters<typeof ownerShare>[0], after: Parameters<typeof ownerShare>[0],
): Promise<OwnerCapAnswer> {
  const survivor = async (share: ReturnType<typeof ownerShare>) => (share === undefined ? undefined : { ...share, owner: await resolveSurvivor(deps, orgId, share.owner) });
  const [from, to] = [await survivor(ownerShare(before)), await survivor(ownerShare(after))];
  // Fix round 2 (N-1): its top-up for the month goes with it to an owner it newly counts for.
  const topUpScope: BudgetScope = subject.kind === "agent" ? { kind: "agent", agentId: subject.agentId } : { kind: "chain", chainId: subject.chainId };
  let carried = 0, carriedSource: OwnerFinancialTerms["carriedSource"];
  if (to !== undefined && from?.owner !== to.owner) {
    const key = topUpKey(orgId, new Date(deps.now()).toISOString().slice(0, 7), topUpScope);
    const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
    if (response.Item !== undefined && usdToWholeMicrodollars(response.Item.amountUsd) === undefined) throw agentXError("CONFIG_INVALID", "The carried monthly amount could not be read. Review Spending before retrying.");
    carried = response.Item === undefined ? 0 : response.Item.amountUsd as number;
    carriedSource = { key, exists: response.Item !== undefined, fields: response.Item ?? {} };
  }
  const checked = await ownerBudgetRefusal(deps, orgId, from, to, (owner) => effectiveOwnerCap(deps, orgId, owner), carried);
  if ("over" in checked && checked.over.ownerFinancialTerms !== undefined && carriedSource !== undefined) checked.over.ownerFinancialTerms = { ...checked.over.ownerFinancialTerms, carriedSource };
  if ("ownerCap" in checked && carriedSource !== undefined) checked.ownerCap.carriedSource = carriedSource;
  return checked;
}
