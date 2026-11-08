// The re-embed job (review H1 and M3 of lane self-hosted-embeddings): gives a vector to every row that should have one and does not.
//
// Which rows: rows that still hold their raw text (the sparse text-due index, `gsi5`: the same index the text-expiry job reads, soonest-to-expire first, so the rows closest to losing their
// text go first) and either
//   - are marked `embedPending` (the embedder could not be reached when they were written, or the vector could not be put), or
//   - have a vector (`embeddingRef`) that was not made with the current embedding spec (`embeddingSpec` missing or different): the Titan-era vectors, and those of any later model change.
// A row whose raw text has expired (30 days, text-expiry.ts) keeps no text to embed. It stays without a vector and is found by keyword only (and by its structured fields): that is the
// documented limit of changing the model, not a failure.
//
// Bounded and quiet: a budget of rows, of index entries read and of time per run; a call is started only when the embedder's longest wait still fits in the run; two failures in a row stop the
// run (the embedder is down or cold: the next run tries again). It never logs text or an error message, only counts.
// Order of writes per row: embed, put the vector, mark the row. A row that was erased or lost its text meanwhile refuses the mark (condition on the text and on no tombstone), and the vector
// just put is deleted again, so a vector never outlives its row because of this job.
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { TEAM_RECORD_GSI5, recordTextDueIndexValue, type OrgId } from "@agentx/contracts";
import { errorName, type Item } from "../agents/table-writes.js";
import { embedWithFlag, eventVectorItem, eventVectorKey, markRowEmbedded } from "./ingest.js";
import { eventFromItem } from "./store.js";
import type { RecordEmbedder, RecordLog, RecordVectorPort, TeamRecordTable } from "./types.js";

export interface ReembedDependencies {
  table: TeamRecordTable;
  embedder: RecordEmbedder & { readonly spec: string };
  vectors: RecordVectorPort;
  now?: (() => number) | undefined;
  log?: RecordLog | undefined;
}

export interface ReembedBudget {
  /** The most rows embedded in one run. */
  maxRows: number;
  /** The most entries of the text-due index read in one run (the filter is applied after the read, so rows that need nothing still cost a read). */
  maxScanned: number;
  /** The run's time: no call is started unless `callMs` of it is left. */
  maxMs: number;
  /** The longest the FIRST call can take (the client's wait: it may be a cold start). */
  callMs: number;
  /** What a later call needs left in the run: the function is warm by then, and a call takes a second or two. A long text can take longer; a run the broker cuts short leaves the data consistent. */
  warmCallMs: number;
}

export const DEFAULT_REEMBED_BUDGET: ReembedBudget = { maxRows: 100, maxScanned: 1_000, maxMs: 28_000, callMs: 20_000, warmCallMs: 8_000 };

export interface ReembedResult {
  embedded: number;
  /** Calls the embedder or the index refused. */
  failed: number;
  /** Rows that were erased or lost their text while their vector was being made (the vector was removed again). */
  skipped: number;
  scanned: number;
  /** True when a budget ended the run with rows left, or the embedder stopped it: the next run continues. */
  more: boolean;
}

/** Rows that need a vector: pending, or with a vector of another spec. Evaluated by DynamoDB after it reads each page of the index. */
function filterFor(spec: string): { FilterExpression: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues: Record<string, unknown> } {
  return {
    FilterExpression: "attribute_not_exists(#tombstone) AND (#pending = :yes OR (attribute_exists(#ref) AND (attribute_not_exists(#spec) OR #spec <> :spec)))",
    ExpressionAttributeNames: { "#tombstone": "tombstone", "#pending": "embedPending", "#ref": "embeddingRef", "#spec": "embeddingSpec" },
    ExpressionAttributeValues: { ":yes": true, ":spec": spec },
  };
}

export async function reembedRows(deps: ReembedDependencies, orgId: OrgId, budget: ReembedBudget = DEFAULT_REEMBED_BUDGET): Promise<ReembedResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const result: ReembedResult = { embedded: 0, failed: 0, skipped: 0, scanned: 0, more: false };
  const { spec } = deps.embedder;
  let failuresInARow = 0;
  let startKey: Record<string, unknown> | undefined;
  for (;;) {
    if (result.scanned >= budget.maxScanned) { result.more = true; break; }
    const filter = filterFor(spec);
    const page = await deps.table.documentClient.send(new QueryCommand({
      TableName: deps.table.tableName,
      IndexName: TEAM_RECORD_GSI5.index,
      // Rows still holding text that is not yet due: the due ones are the text-expiry job's.
      KeyConditionExpression: `${TEAM_RECORD_GSI5.partition} = :pk AND ${TEAM_RECORD_GSI5.sort} > :now`,
      FilterExpression: filter.FilterExpression,
      ExpressionAttributeNames: filter.ExpressionAttributeNames,
      ExpressionAttributeValues: { ...filter.ExpressionAttributeValues, ":pk": recordTextDueIndexValue(orgId), ":now": new Date(now()).toISOString() },
      Limit: 100,
      ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown>; ScannedCount?: number };
    result.scanned += page.ScannedCount ?? (page.Items ?? []).length;
    for (const item of page.Items ?? []) {
      const needed = result.embedded + result.failed + result.skipped === 0 ? budget.callMs : budget.warmCallMs;
      if (result.embedded >= budget.maxRows || now() - started + needed > budget.maxMs) { result.more = true; return result; }
      const event = eventFromItem(item, Math.floor(now() / 1000));
      if (event === undefined || event.text === undefined) continue;
      try {
        const { vector, truncated } = await embedWithFlag(deps.embedder, event.text);
        const put = await deps.vectors.put([eventVectorItem(event, vector)]);
        if (put.failed.length > 0) throw new Error("vector not put");
        try {
          await markRowEmbedded(deps.table, event, { spec, truncated, onlyWithText: true });
        } catch (error) {
          if (errorName(error) !== "ConditionalCheckFailedException") throw error;
          // The row is gone, hidden or without text: the vector must not outlive it.
          const key = eventVectorKey(event.id);
          const removed = await deps.vectors.delete([key]).then((response) => response.failed.length === 0, () => false);
          if (!removed) deps.log?.("record.reembed_vector_left", {});
          result.skipped += 1;
          continue;
        }
        if (truncated) deps.log?.("record.embed_truncated", { kind: event.kind });
        result.embedded += 1;
        failuresInARow = 0;
      } catch {
        // No message: an embedding error can echo the text. Two failures in a row mean the embedder (or the index) is not answering: stop and let the next run try.
        result.failed += 1;
        failuresInARow += 1;
        if (failuresInARow >= 2) { result.more = true; deps.log?.("record.reembed_stopped", { failed: result.failed }); return result; }
      }
    }
    startKey = page.LastEvaluatedKey;
    if (startKey === undefined) break;
  }
  if (result.embedded > 0 || result.failed > 0) deps.log?.("record.reembed", { embedded: result.embedded, failed: result.failed, skipped: result.skipped });
  return result;
}
