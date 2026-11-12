// The late marker of the keyword index (lane K2, DECISIONS 145): written in the SAME transaction as a row whose `occurredAt` is older than KEYWORD_LATE_MS when it is written. Such a row may fall inside an index segment that is
// sealed already, so the search reads it live until a rebuild folds it in (keyword-index.ts). Kept apart from the index so the store can write it without a cycle of imports.
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { teamRecordPk, type OrgId } from "@rovara-code/contracts";
import { errorName, type Item } from "../agents/table-writes.js";
import type { TeamRecordTable } from "./types.js";

/** A row older than this when it is written gets a late marker, and a seal never takes rows newer than this: the margin that makes the tail and the sealed part meet with no gap (clock skew is far smaller). */
export const KEYWORD_LATE_MS = 2 * 3_600_000;
export const KWLATE_PREFIX = "KWLATE#";
const LATE_MARKER_TTL_S = 30 * 86_400;

export const lateMarkerKey = (orgId: OrgId, project: string | undefined, occurredAt: string, id: string): { pk: string; sk: string } => ({ pk: teamRecordPk(orgId, project), sk: `${KWLATE_PREFIX}${occurredAt}#${id}` });

/** The item a late row's transaction writes beside the row (key and a TTL only: no text, no words). */
export function lateMarkerItem(orgId: OrgId, project: string | undefined, occurredAt: string, id: string, nowMs: number): Item {
  return { ...lateMarkerKey(orgId, project, occurredAt, id), entityType: "TEAM_RECORD_KWLATE", indexExpiresAt: Math.floor(nowMs / 1000) + LATE_MARKER_TTL_S };
}

/** Whether a row written at `nowMs` with this `occurredAt` needs a late marker. */
export const isLateRow = (occurredAt: string, nowMs: number): boolean => Date.parse(occurredAt) <= nowMs - KEYWORD_LATE_MS;

/** Writes a row and its late marker in one transaction. Returns "duplicate" when the row already existed (the marker is then not written; the earlier write wrote it). */
export async function putLateRecordEvent(table: TeamRecordTable, rowItem: Item, marker: Item): Promise<"stored" | "duplicate"> {
  try {
    await table.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: table.tableName, Item: rowItem, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: table.tableName, Item: marker } },
    ] }));
    return "stored";
  } catch (error) {
    if (errorName(error) !== "TransactionCanceledException") throw error;
    const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
    if (Array.isArray(reasons) && reasons[0]?.Code === "ConditionalCheckFailed") return "duplicate";
    throw error;
  }
}
