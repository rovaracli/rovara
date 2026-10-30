// R4: the lake delete job (design 4.4.3). Athena DELETE on an Iceberg table writes position-delete files; S3 Tables compaction and
// snapshot expiry then remove the bytes (physically gone in about 15 days, which the DPA states). The statements are DELETE, which Athena
// cannot parameterise, so every value is checked first: our own safe ids, or a sha256 hash of the source id. Batched, bounded per run,
// and a target is acknowledged only after its statement succeeded (a failed one stays queued and the next run retries it).
import type { LakeClient } from "./lake.js";
import { LakeError } from "./lake.js";
import { deleteLiteral, tableRef } from "./lake-sql.js";
import { assertSafeId } from "./shared-types.js";

export const DELETE_BATCH = 100;

export type LakeDeleteTarget =
  | { kind: "source"; sourceHash: string }
  | { kind: "actor"; developerId: string }
  | { kind: "project"; project: string }
  | { kind: "fact"; factId: string };

export interface PendingLakeDelete {
  /** The queue entry's own id, handed back to ack. */
  id: string;
  target: LakeDeleteTarget;
}

export interface LakeDeleteQueue {
  listPending(workspaceId: string, limit: number): Promise<PendingLakeDelete[]>;
  ack(workspaceId: string, ids: string[]): Promise<void>;
}

export interface LakeDeleteBudget {
  maxStatements: number;
  maxMs: number;
}

export interface LakeDeleteSummary {
  statements: number;
  acked: number;
  failed: number;
  halted?: "budget" | "lake_unavailable" | "lake_query_failed" | "lake_timeout";
}

/** The DELETE statements for a list of targets, batched. Throws before returning anything if a value is not allowed. */
export function buildLakeDeletes(bucket: string, workspaceId: string, items: PendingLakeDelete[]): Array<{ sql: string; entryIds: string[] }> {
  assertSafeId(workspaceId, "workspace id");
  const ws = `"workspace_id" = ${deleteLiteral(workspaceId, "id")}`;
  const events = tableRef(bucket, "events");
  const facts = tableRef(bucket, "facts");
  const out: Array<{ sql: string; entryIds: string[] }> = [];

  const sources = items.filter((item): item is PendingLakeDelete & { target: { kind: "source" } } => item.target.kind === "source");
  for (let i = 0; i < sources.length; i += DELETE_BATCH) {
    const batch = sources.slice(i, i + DELETE_BATCH);
    const list = [...new Set(batch.map((item) => deleteLiteral(item.target.sourceHash, "hash")))].join(", ");
    out.push({ sql: `DELETE FROM ${events} WHERE ${ws} AND "source_hash" IN (${list})`, entryIds: batch.map((item) => item.id) });
  }
  const factItems = items.filter((item): item is PendingLakeDelete & { target: { kind: "fact" } } => item.target.kind === "fact");
  for (let i = 0; i < factItems.length; i += DELETE_BATCH) {
    const batch = factItems.slice(i, i + DELETE_BATCH);
    const list = [...new Set(batch.map((item) => deleteLiteral(item.target.factId, "id")))].join(", ");
    out.push({ sql: `DELETE FROM ${facts} WHERE ${ws} AND "id" IN (${list})`, entryIds: batch.map((item) => item.id) });
  }
  for (const item of items) {
    if (item.target.kind === "actor") {
      // A person erase: their events and the outcomes they own.
      const who = deleteLiteral(item.target.developerId, "id");
      out.push({ sql: `DELETE FROM ${events} WHERE ${ws} AND "actor_developer_id" = ${who}`, entryIds: [item.id] });
      out.push({ sql: `DELETE FROM ${tableRef(bucket, "outcomes")} WHERE ${ws} AND "actor_developer_id" = ${who}`, entryIds: [item.id] });
    } else if (item.target.kind === "project") {
      const project = deleteLiteral(item.target.project, "id");
      for (const table of ["events", "facts", "outcomes", "lessons_history"] as const) {
        out.push({ sql: `DELETE FROM ${tableRef(bucket, table)} WHERE ${ws} AND "project" = ${project}`, entryIds: [item.id] });
      }
    }
  }
  return out;
}

export async function runLakeDeletes(
  deps: { queue: LakeDeleteQueue; lake: LakeClient; tableBucket: string },
  request: { workspaceId: string; budget: LakeDeleteBudget },
): Promise<LakeDeleteSummary> {
  const started = deps.lake.now();
  const summary: LakeDeleteSummary = { statements: 0, acked: 0, failed: 0 };
  const pending = await deps.queue.listPending(request.workspaceId, request.budget.maxStatements * DELETE_BATCH);
  if (pending.length === 0) return summary;

  // Build per entry, so one entry with a value that is not allowed is refused alone (left in the queue, counted as failed) and the others still run.
  const accepted: PendingLakeDelete[] = [];
  for (const item of pending) {
    try {
      buildLakeDeletes(deps.tableBucket, request.workspaceId, [item]);
      accepted.push(item);
    } catch {
      summary.failed += 1;
    }
  }
  const statements = buildLakeDeletes(deps.tableBucket, request.workspaceId, accepted);
  const remaining = new Map<string, number>();
  for (const statement of statements) for (const id of new Set(statement.entryIds)) remaining.set(id, (remaining.get(id) ?? 0) + 1);

  const done: string[] = [];
  for (const statement of statements) {
    if (summary.statements >= request.budget.maxStatements || deps.lake.now() - started >= request.budget.maxMs) {
      summary.halted = "budget";
      break;
    }
    try {
      await deps.lake.execute(statement.sql, []);
    } catch (error) {
      summary.halted = error instanceof LakeError ? error.code : "lake_unavailable";
      break;
    }
    summary.statements += 1;
    for (const id of new Set(statement.entryIds)) {
      const left = (remaining.get(id) ?? 1) - 1;
      remaining.set(id, left);
      if (left === 0) done.push(id);
    }
  }
  if (done.length > 0) {
    await deps.queue.ack(request.workspaceId, done);
    summary.acked = done.length;
  }
  return summary;
}
