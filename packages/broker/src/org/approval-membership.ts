import type { TransactItem } from "../audit/outbox.js";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, orgMetaKey, projectMetaKey, type OrgId, type OrgKey } from "@agentx/contracts";
type Item = Record<string, unknown>;
export interface ApprovalMembershipDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => Date;
}
async function getItem(deps: ApprovalMembershipDependencies, key: OrgKey): Promise<Item | undefined> {
  return (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Item }).Item;
}
/** Invalidate all reviewed eligibility snapshots in the same transaction as
 * a grant mutation. Legacy records without META cannot supply approval proof. */
export async function approvalGrantChange(deps: ApprovalMembershipDependencies, orgId: OrgId, project: string, lostMaintainer: boolean, options: { allowClosing?: boolean } = {}): Promise<TransactItem[]> {
  const at = deps.now().toISOString();
  const items: TransactItem[] = [];
  if (await getItem(deps, orgMetaKey(orgId)) !== undefined) items.push({ Update: {
    TableName: deps.tableName, Key: orgMetaKey(orgId),
    UpdateExpression: "SET approvalMembershipVersion = if_not_exists(approvalMembershipVersion, :zero) + :one, approvalTrackingSince = if_not_exists(approvalTrackingSince, :at)",
    ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(closedAt)" + (options.allowClosing === true ? "" : " AND attribute_not_exists(closingAt)"),
    ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":at": at },
  } });
  if (lostMaintainer) {
    const meta = await getItem(deps, projectMetaKey(orgId, project));
    if (meta !== undefined) {
      const loss = approvalLossPlan("approvalLastMaintainerLossAt", meta.approvalLastMaintainerLossAt, at);
      items.push({ Update: {
        TableName: deps.tableName, Key: projectMetaKey(orgId, project),
        UpdateExpression: "SET approvalLastMaintainerLossAt = :lossAt",
        ConditionExpression: "attribute_exists(pk) AND " + loss.condition, ExpressionAttributeValues: loss.values,
      } });
    }
  }
  return items;
}


/** A concurrent loss cannot be replaced by an older observation; callers merge
 * the returned condition into the same transaction action as the loss write. */
export function approvalLossPlan(field: "approvalLastMaintainerLossAt" | "approvalLastCompanyEligibleLossAt", previous: unknown, at: string): {
  at: string; condition: string; values: Record<string, unknown>;
} {
  if (previous !== undefined && (typeof previous !== "string" || !Number.isFinite(Date.parse(previous)))) throw agentXError("RUNTIME_UNAVAILABLE", "approval eligibility history could not be read");
  const next = new Date(Math.max(Date.parse(at), previous === undefined ? 0 : Date.parse(previous))).toISOString();
  return { at: next, condition: previous === undefined ? `attribute_not_exists(${field})` : `${field} = :seenLossAt`,
    values: { ":lossAt": next, ...(previous === undefined ? {} : { ":seenLossAt": previous }) } };
}

/** Company membership/role writers use this in the same transaction as their
 * member and pointer mutation. Absence of META cannot establish approval proof. */
export async function approvalCompanyChange(deps: ApprovalMembershipDependencies, orgId: OrgId, companyEligibleLost: boolean): Promise<Item[]> {
  const at = deps.now().toISOString(), meta = await getItem(deps, orgMetaKey(orgId));
  if (meta === undefined) return [];
  const loss = companyEligibleLost ? approvalLossPlan("approvalLastCompanyEligibleLossAt", meta.approvalLastCompanyEligibleLossAt, at) : undefined;
  return [{ Update: {
    TableName: deps.tableName, Key: orgMetaKey(orgId),
    UpdateExpression: "SET approvalMembershipVersion = if_not_exists(approvalMembershipVersion, :zero) + :one, approvalTrackingSince = if_not_exists(approvalTrackingSince, :at)" + (loss === undefined ? "" : ", approvalLastCompanyEligibleLossAt = :lossAt"),
    ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(closedAt) AND attribute_not_exists(closingAt)" + (loss === undefined ? "" : " AND " + loss.condition),
    ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":at": at, ...loss?.values },
  } }];
}
