// Retention C (design 4.3): the raw text of a row and the row's event vector are removed 30 days after the item, while the row itself stays (like D's) so its
// structured fields reach the lake when the archiver takes it at 90 days. DynamoDB's TTL removes whole items, so this nightly job does the partial removal.
//
// It reads a SPARSE index (`gsi5`): only rows that still hold text with an expiry are in it, sorted by the expiry time. So the job reads exactly the due rows, a row it
// has handled leaves the index, and a night that stops early resumes where the work is, never rescanning finished rows (it cannot stall behind them).
// Order: the vector first, then the text (a vector that cannot be deleted keeps the text, counts as blocked, and the next night tries again).
// Reads never wait for this job: `eventFromItem` drops text past its expiry, and the archiver strips it (hot-source.ts). The job's lag is reported (`lagSeconds`) and
// `alarm` is true when a row is more than a day late or any row is blocked: the scheduler must alarm on it. Removed text lives on in point-in-time recovery for up to
// 35 more days (a DPA note).
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { RECORD_RAW_TEXT_DAYS_C, TEAM_RECORD_GSI5, recordTextDueIndexValue, type OrgId } from "@agentx/contracts";
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
/** A row whose text is this many seconds past its expiry raises the alarm. */
export const TEXT_EXPIRY_LAG_ALARM_SECONDS = 86_400;

export interface TextExpiryResult {
  /** Rows whose text and vector were removed. */
  expired: number;
  /** Rows left with their text because the vector could not be deleted (or there is no vector port). */
  blocked: number;
  /** True when the budget ended the run with due rows left: call again (the scheduler loops until false or the night's budget ends). */
  more: boolean;
  /** How far past its expiry the oldest handled or blocked row was, in seconds. */
  lagSeconds: number;
  alarm: boolean;
}

/** One workspace (every project): the due rows from the sparse index. */
export async function expireRawText(deps: TextExpiryDependencies, orgId: OrgId, budget: TextExpiryBudget = DEFAULT_TEXT_EXPIRY_BUDGET): Promise<TextExpiryResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const result: TextExpiryResult = { expired: 0, blocked: 0, more: false, lagSeconds: 0, alarm: false };
  // Rows that cannot be handled (their vector will not delete) stay in the index, so the scan pages past them with the index's own key instead of starting over: a pile of
  // blocked rows at the front cannot starve the rows behind them. Only rows actually expired use the item budget; the scan itself is bounded by 10x that and the clock.
  let handled = 0;
  let scanned = 0;
  let startKey: Record<string, unknown> | undefined;
  for (;;) {
    if (handled >= budget.maxItems || scanned >= budget.maxItems * 10 || now() - started >= budget.maxMs) { result.more = true; break; }
    const page = await deps.table.documentClient.send(new QueryCommand({
      TableName: deps.table.tableName,
      IndexName: TEAM_RECORD_GSI5.index,
      KeyConditionExpression: `${TEAM_RECORD_GSI5.partition} = :pk AND ${TEAM_RECORD_GSI5.sort} <= :due`,
      ExpressionAttributeValues: { ":pk": recordTextDueIndexValue(orgId), ":due": new Date(now()).toISOString() },
      Limit: 100,
      ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    const items = page.Items ?? [];
    scanned += items.length;
    for (const item of items) {
      if (handled >= budget.maxItems) { result.more = true; break; }
      const dueAt = typeof item.textDueAt === "string" ? Date.parse(item.textDueAt) : now();
      result.lagSeconds = Math.max(result.lagSeconds, Math.max(0, Math.floor((now() - dueAt) / 1000)));
      if (typeof item.id !== "string" || typeof item.pk !== "string" || typeof item.sk !== "string") { result.blocked += 1; continue; }
      const vectorKey = eventVectorKey(item.id);
      const gone = deps.vectors === undefined ? item.embeddingRef === undefined : await deps.vectors.delete([vectorKey]).then((response) => !response.failed.includes(vectorKey), () => false);
      if (!gone) { result.blocked += 1; continue; }
      const aliases = new Aliases();
      try {
        await deps.table.documentClient.send(new UpdateCommand({
          TableName: deps.table.tableName,
          Key: { pk: item.pk, sk: item.sk },
          UpdateExpression: `REMOVE ${["text", "textExpiresAt", "embeddingRef", "embeddingSpec", "embeddingTruncated", "embedPending", TEAM_RECORD_GSI5.partition, TEAM_RECORD_GSI5.sort].map((name) => aliases.name(name)).join(", ")}`,
          ConditionExpression: `attribute_exists(${aliases.name("text")})`,
          ExpressionAttributeNames: aliases.names,
        }));
        result.expired += 1;
        handled += 1;
      } catch (error) {
        if (errorName(error) !== "ConditionalCheckFailedException") throw error;
      }
    }
    if (result.more) break;
    startKey = page.LastEvaluatedKey;
    if (startKey === undefined) break;
  }
  result.alarm = result.blocked > 0 || result.lagSeconds > TEXT_EXPIRY_LAG_ALARM_SECONDS;
  if (result.alarm) deps.log?.("record.text_expiry_alarm", { blocked: result.blocked, lagSeconds: result.lagSeconds });
  return result;
}

export { RECORD_RAW_TEXT_DAYS_C };
