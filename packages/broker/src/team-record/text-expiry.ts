// Retention C (design 4.3): the raw text of a row and the row's event vector are removed 30 days after the item, while the row itself stays (like D's) so its
// structured fields reach the lake when the archiver takes it at 90 days. DynamoDB's TTL removes whole items, so this nightly job does the partial removal.
// Order: the vector first, then the text (a vector that cannot be deleted keeps the text and the job counts it, so the next night tries again).
// Bounded by items and milliseconds; a run returns a cursor to continue from. It reads only rows older than 30 days.
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { RECORD_EVENT_SK_PREFIX, RECORD_RAW_TEXT_DAYS_C, teamRecordPk, type OrgId } from "@agentx/contracts";
import { Aliases, errorName, type Item } from "../agents/table-writes.js";
import { eventVectorKey } from "./ingest.js";
import type { RecordLog, RecordVectorPort, TeamRecordTable } from "./types.js";

export interface TextExpiryDependencies {
  table: TeamRecordTable;
  vectors?: RecordVectorPort | undefined;
  now?: (() => number) | undefined;
  log?: RecordLog | undefined;
}

export interface TextExpiryBudget { maxItems: number; maxMs: number }
export const DEFAULT_TEXT_EXPIRY_BUDGET: TextExpiryBudget = { maxItems: 2_000, maxMs: 20_000 };

export interface TextExpiryResult {
  /** Rows whose text and vector were removed. */
  expired: number;
  /** Rows left with their text because the vector could not be deleted. */
  blocked: number;
  /** Continue from here (same project), or undefined when the project's old rows were all read. */
  cursor?: Record<string, unknown> | undefined;
}

/** One project's partition (or the workspace's own when `project` is undefined). */
export async function expireRawText(deps: TextExpiryDependencies, orgId: OrgId, project: string | undefined, budget: TextExpiryBudget = DEFAULT_TEXT_EXPIRY_BUDGET, cursor?: Record<string, unknown>): Promise<TextExpiryResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const nowSeconds = Math.floor(now() / 1000);
  const upper = `${RECORD_EVENT_SK_PREFIX}${new Date(now() - RECORD_RAW_TEXT_DAYS_C * 86_400_000).toISOString()}￿`;
  const result: TextExpiryResult = { expired: 0, blocked: 0 };
  let startKey = cursor;
  let read = 0;
  for (;;) {
    if (read >= budget.maxItems || now() - started >= budget.maxMs) { result.cursor = startKey; return result; }
    const page = await deps.table.documentClient.send(new QueryCommand({
      TableName: deps.table.tableName,
      KeyConditionExpression: "pk = :pk AND sk BETWEEN :low AND :high",
      ExpressionAttributeValues: { ":pk": teamRecordPk(orgId, project), ":low": RECORD_EVENT_SK_PREFIX, ":high": upper },
      Limit: Math.min(budget.maxItems - read, 200),
      ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    const items = page.Items ?? [];
    read += items.length;
    for (const item of items) {
      if (typeof item.text !== "string" || typeof item.textExpiresAt !== "number" || item.textExpiresAt > nowSeconds) continue;
      if (typeof item.id !== "string" || typeof item.pk !== "string" || typeof item.sk !== "string") continue;
      const key = eventVectorKey(item.id);
      // The vector goes first. A row that never had one (retention keeps text but the embedding failed) has nothing to delete, but deleting a missing key is harmless.
      const gone = deps.vectors === undefined ? (item.embeddingRef === undefined) : await deps.vectors.delete([key]).then((response) => !response.failed.includes(key), () => false);
      if (!gone) { result.blocked += 1; continue; }
      const aliases = new Aliases();
      try {
        await deps.table.documentClient.send(new UpdateCommand({
          TableName: deps.table.tableName,
          Key: { pk: item.pk, sk: item.sk },
          UpdateExpression: `REMOVE ${["text", "textExpiresAt", "embeddingRef", "embedPending"].map((name) => aliases.name(name)).join(", ")}`,
          ConditionExpression: `attribute_exists(${aliases.name("text")})`,
          ExpressionAttributeNames: aliases.names,
        }));
        result.expired += 1;
      } catch (error) {
        if (errorName(error) !== "ConditionalCheckFailedException") throw error;
      }
    }
    startKey = page.LastEvaluatedKey;
    if (startKey === undefined) return result;
  }
}
