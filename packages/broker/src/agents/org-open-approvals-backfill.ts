// 0.5.15: the one-off backfill of the companies' open indexes (`ORG#<org>#OPEN_APPROVALS`, `orgOpenApprovalKey`). Approvals that were open before this release have an item in the install-wide
// `OPEN_APPROVALS` index and none in their company's, so this walks the global index once and gives each PENDING approval its company item.
//
//  - Idempotent: an item's content depends only on the record, so a second pass (or a run that stopped and came back) writes the same items. The Put and a check that the record is still PENDING are ONE
//    transaction, so an approval that is decided while the backfill reads it is never given an item nobody would delete.
//  - Resumable: the walk's place (`cursor`, a sort key of the global index) is kept in the marker item after every page; a run stops at its deadline and the next one starts there.
//  - Marked: `completedAt` is set only when the walk reached the end of the index. Until then the pending-approvals summary reads the global index (a company's partition may be partial);
//    after it, the summary reads the company's partition alone. Approvals made from 0.5.15 on get their item in their own transaction, so nothing made after the deploy needs this.
//  - Re-runnable by an operator: deleting the marker item (`ORG_OPEN_APPROVALS_BACKFILL_KEY`) makes the settlement job walk again, and the summary read the global index meanwhile.
// It runs from the settlement job (every 5 minutes) with what is left of the approvals job's budget, and it does nothing at all once the marker says it is done.
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ORG_OPEN_APPROVALS_BACKFILL_KEY, orgOpenApprovalKey } from "@agentx/cloud-contracts";
import { approvalKey, type ApprovalId, type OrgId } from "@rovara-code/contracts";
import type { ApprovalDependencies } from "./approvals-store.js";
import { DUE_SK, errorNameOf, iso, log, orgOpenFields } from "./approvals-store.js";

const PAGE = 100;

export interface OrgOpenBackfillReport {
  /** False when the marker already said the backfill was done (nothing was read besides it). */
  ran: boolean;
  /** Company items written by this run. */
  copied: number;
  /** Global index items that needed none (not PENDING any more, another kind of due item, unreadable) or that were decided while being read. */
  skipped: number;
  /** True when the whole global index has been read (this run or an earlier one). */
  complete: boolean;
}

export async function backfillOrgOpenApprovals(
  deps: Pick<ApprovalDependencies, "documentClient" | "tableName" | "now" | "log">,
  options: { deadline?: number; pageSize?: number } = {},
): Promise<OrgOpenBackfillReport> {
  const marker = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: ORG_OPEN_APPROVALS_BACKFILL_KEY, ConsistentRead: true })) as { Item?: { completedAt?: unknown; cursor?: unknown; copied?: unknown } };
  if (typeof marker.Item?.completedAt === "string") return { ran: false, copied: 0, skipped: 0, complete: true };
  let cursor = typeof marker.Item?.cursor === "string" && DUE_SK.test(marker.Item.cursor) ? marker.Item.cursor : undefined;
  const before = typeof marker.Item?.copied === "number" ? marker.Item.copied : 0;
  const report: OrgOpenBackfillReport = { ran: true, copied: 0, skipped: 0, complete: false };
  const save = async (done: boolean): Promise<void> => {
    try {
      await deps.documentClient.send(new PutCommand({
        TableName: deps.tableName,
        Item: { ...ORG_OPEN_APPROVALS_BACKFILL_KEY, entityType: "OPEN_APPROVALS_ORG_BACKFILL", copied: before + report.copied, updatedAt: iso(deps.now()), ...(done ? { completedAt: iso(deps.now()) } : cursor === undefined ? {} : { cursor }) },
      }));
    } catch (error) {
      // Losing the place only repeats work (the walk is idempotent); losing the completion mark only keeps the summary on the old read until the next run.
      log(deps, "approval.org_index_backfill_not_saved", { error: errorNameOf(error) });
    }
  };
  for (;;) {
    if (options.deadline !== undefined && deps.now() >= options.deadline) { await save(false); return report; }
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": "OPEN_APPROVALS" }, ConsistentRead: true, Limit: options.pageSize ?? PAGE,
      ...(cursor === undefined ? {} : { ExclusiveStartKey: { pk: "OPEN_APPROVALS", sk: cursor } }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      const sk = String(item["sk"]);
      if (options.deadline !== undefined && deps.now() >= options.deadline) { await save(false); return report; }
      const parts = DUE_SK.exec(sk);
      if (parts !== null && item["orgId"] === parts[2] && item["approvalId"] === parts[3] && await copyOne(deps, parts[2] as OrgId, parts[3] as ApprovalId)) report.copied += 1;
      else report.skipped += 1;
      cursor = sk;
    }
    if (page.LastEvaluatedKey === undefined) { await save(true); report.complete = true; log(deps, "approval.org_index_backfilled", { copied: before + report.copied }); return report; }
    cursor = typeof page.LastEvaluatedKey["sk"] === "string" ? page.LastEvaluatedKey["sk"] : cursor;
    await save(false);
  }
}

/** Gives one PENDING approval its company item, in one transaction with a check that it is still PENDING. False when it needs none or was decided meanwhile. */
async function copyOne(deps: Pick<ApprovalDependencies, "documentClient" | "tableName" | "log">, orgId: OrgId, approvalId: ApprovalId): Promise<boolean> {
  const key = approvalKey(orgId, approvalId);
  const read = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const record = read.Item;
  if (record === undefined || record["status"] !== "PENDING" || record["orgId"] !== orgId || typeof record["createdAt"] !== "string" || typeof record["expiresAt"] !== "string") return false;
  let item: Record<string, unknown>;
  try {
    item = { ...orgOpenApprovalKey(orgId, record["createdAt"], approvalId), entityType: "ORG_OPEN_APPROVAL", ...orgOpenFields({ orgId, approvalId, expiresAt: record["expiresAt"] }) };
  } catch {
    // A time that is not an instant can't be keyed (no writer makes one): skipped and logged, never a reason to stop the walk.
    log(deps, "approval.org_index_backfill_item_skipped", { orgId, approvalId });
    return false;
  }
  try {
    await deps.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        { ConditionCheck: { TableName: deps.tableName, Key: key, ConditionExpression: "#status = :pending", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":pending": "PENDING" } } },
        { Put: { TableName: deps.tableName, Item: item } },
      ],
    }));
    return true;
  } catch (error) {
    // Decided between the read and the write: nothing to list. Any other failure (a throttle) stops this run before the walk's place moves past the item, so the next run tries it again.
    if (errorNameOf(error) === "TransactionCanceledException") return false;
    throw error;
  }
}
