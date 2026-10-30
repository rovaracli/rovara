// R4: the nightly archiver. Hot rows older than 90 days go to the lake (Parquet through Iceberg) and their vectors are re-tagged `lake`
// (design 4.3 and 4.9.1). Safe to stop and re-run at any point:
//   1. the lake insert skips ids that are already there (INSERT ... WHERE NOT EXISTS);
//   2. the vector re-tag is a plain overwrite with tier=lake;
//   3. only after both succeed is the hot row marked archived, and only that mark removes it from the next listing.
// Bounded per run by rows and milliseconds. Raw text goes to the lake only for retention D; C keeps structured metadata only (design 4.3).
import type { LakeClient } from "./lake.js";
import { LakeError } from "./lake.js";
import { buildInsertIfAbsent, sourceHash, type LakeValue } from "./lake-sql.js";
import type { RecordEventLike } from "./shared-types.js";
import { assertSafeId } from "./shared-types.js";
import type { VectorIndex } from "./vectors.js";

export const HOT_DAYS = 90;
const DAY_MS = 86_400_000;
export const DEFAULT_ROWS_PER_INSERT = 10;

export interface HotArchiveSource {
  /** Live and not yet archived rows of the workspace that occurred before `olderThan`, oldest first. `cursor` resumes inside a run. */
  listArchivable(request: { workspaceId: string; olderThan: string; limit: number; cursor?: string }): Promise<{ rows: RecordEventLike[]; nextCursor?: string }>;
  /** Of these ids, the ones that are still live right now (no tombstone). Asked just before the insert, so a delete that landed during the run wins. */
  filterLive(workspaceId: string, ids: string[]): Promise<Set<string>>;
  markArchived(workspaceId: string, ids: string[], archivedAt: string): Promise<void>;
}

export interface ArchiverDeps {
  source: HotArchiveSource;
  lake: LakeClient;
  tableBucket: string;
  /** The workspace's index. Public: one per workspace. */
  vectors: VectorIndex;
  rowsPerInsert?: number;
}

export interface ArchiveBudget {
  maxRows: number;
  maxMs: number;
}

export interface ArchiveSummary {
  archived: number;
  skippedTombstoned: number;
  vectorsRetagged: number;
  vectorsMissing: number;
  /** Rows written to the lake but left unmarked (the re-tag failed); the next run retries them. */
  retryLater: number;
  halted?: "lake_unavailable" | "lake_query_failed" | "lake_timeout" | "budget";
  cursor?: string;
}

/** The lake row of a hot event. Text only under D. */
export function toLakeEventRow(event: RecordEventLike, archivedAt: string): Record<string, LakeValue> {
  assertSafeId(event.workspaceId, "workspace id");
  return {
    workspace_id: event.workspaceId,
    occurred_at: event.occurredAt,
    id: event.id,
    project: event.project ?? null,
    repo: event.repo ?? null,
    source: event.source,
    source_system: event.sourceRef.system,
    source_hash: sourceHash(event.sourceRef.system, event.sourceRef.id),
    source_version: event.sourceRef.version ?? null,
    kind: event.kind,
    actor_developer_id: event.actor?.developerId ?? null,
    trust: event.trust,
    audience_kind: event.audience.kind,
    audience_scope: event.audience.kind === "restricted" ? event.audience.acl.scope : null,
    acl_json: event.audience.kind === "restricted" ? JSON.stringify(event.audience.acl) : null,
    text: event.retention === "D" && event.text !== undefined ? event.text : null,
    structured_json: event.structured === undefined ? null : JSON.stringify(event.structured),
    links_json: JSON.stringify(event.links),
    retention: event.retention,
    archived_at: archivedAt,
  };
}

function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
}

export async function runArchive(deps: ArchiverDeps, request: { workspaceId: string; budget: ArchiveBudget; cursor?: string }): Promise<ArchiveSummary> {
  assertSafeId(request.workspaceId, "workspace id");
  const now = deps.lake.now;
  const started = now();
  const archivedAt = isoSeconds(started);
  const olderThan = isoSeconds(started - HOT_DAYS * DAY_MS);
  const perInsert = deps.rowsPerInsert ?? DEFAULT_ROWS_PER_INSERT;
  const summary: ArchiveSummary = { archived: 0, skippedTombstoned: 0, vectorsRetagged: 0, vectorsMissing: 0, retryLater: 0 };
  let cursor = request.cursor;
  let seen = 0;

  for (;;) {
    if (seen >= request.budget.maxRows || now() - started >= request.budget.maxMs) {
      summary.halted = "budget";
      if (cursor !== undefined) summary.cursor = cursor;
      return summary;
    }
    const page = await deps.source.listArchivable({
      workspaceId: request.workspaceId,
      olderThan,
      limit: Math.min(perInsert * 5, request.budget.maxRows - seen),
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (page.rows.length === 0) return summary;
    seen += page.rows.length;
    cursor = page.nextCursor;

    // Fail closed on the row itself: wrong workspace, or already tombstoned, never reaches the lake.
    const candidates = page.rows.filter((row) => {
      const ok = row.workspaceId === request.workspaceId && row.tombstone === undefined;
      if (!ok) summary.skippedTombstoned += 1;
      return ok;
    });
    const live = await deps.source.filterLive(request.workspaceId, candidates.map((row) => row.id));
    const rows = candidates.filter((row) => {
      if (live.has(row.id)) return true;
      summary.skippedTombstoned += 1;
      return false;
    });

    for (let i = 0; i < rows.length; i += perInsert) {
      const batch = rows.slice(i, i + perInsert);
      try {
        const insert = buildInsertIfAbsent(deps.tableBucket, "events", batch.map((row) => toLakeEventRow(row, archivedAt)));
        await deps.lake.execute(insert.sql, insert.parameters);
      } catch (error) {
        summary.halted = error instanceof LakeError ? error.code : "lake_unavailable";
        if (cursor !== undefined) summary.cursor = cursor;
        return summary;
      }
      const { ready, retagged, missing } = await retag(deps.vectors, batch);
      summary.vectorsRetagged += retagged;
      summary.vectorsMissing += missing;
      summary.retryLater += batch.length - ready.length;
      if (ready.length > 0) {
        await deps.source.markArchived(request.workspaceId, ready.map((row) => row.id), archivedAt);
        summary.archived += ready.length;
      }
    }
    if (cursor === undefined) return summary;
  }
}

/** Re-tags the vectors of retention-D rows as `lake`. Returns the rows that are safe to mark archived. */
async function retag(vectors: VectorIndex, batch: RecordEventLike[]): Promise<{ ready: RecordEventLike[]; retagged: number; missing: number }> {
  const withVector = batch.filter((row) => row.retention === "D" && row.embeddingRef !== undefined);
  if (withVector.length === 0) return { ready: batch, retagged: 0, missing: 0 };
  let found;
  try {
    found = await vectors.get(withVector.map((row) => row.embeddingRef!));
  } catch {
    return { ready: batch.filter((row) => !withVector.includes(row)), retagged: 0, missing: 0 };
  }
  const byKey = new Map(found.map((item) => [item.key, item]));
  const toWrite = withVector.flatMap((row) => {
    const item = byKey.get(row.embeddingRef!);
    return item === undefined ? [] : [{ ...item, metadata: { ...item.metadata, tier: "lake" as const } }];
  });
  const missing = withVector.length - toWrite.length;
  let failed = new Set<string>();
  if (toWrite.length > 0) {
    try {
      failed = new Set((await vectors.put(toWrite)).failed);
    } catch {
      failed = new Set(toWrite.map((item) => item.key));
    }
  }
  const ready = batch.filter((row) => row.embeddingRef === undefined || row.retention !== "D" || !failed.has(row.embeddingRef));
  return { ready, retagged: toWrite.length - failed.size, missing };
}
