// R4 (review I-9): row builders and a batched writer for the lake tables other than `events` (outcomes, facts), so the lanes that own
// those records can put them in the lake. Nothing in the storage lane decides WHEN they are written: the writers are named in report.md.
import type { LakeClient } from "./lake.js";
import { buildInsertIfAbsent, developerIdHash, scopeHash, timestampText, type LakeValue } from "./lake-sql.js";
import { lakeAcl } from "./person-fields.js";
import type { RecordFactLike } from "./shared-types.js";

export interface OutcomeLike {
  id: string;
  workspaceId: string;
  project?: string;
  taskId: string;
  outcome: "merged" | "closed" | "reverted" | "abandoned";
  occurredAt: string;
  sendBacks?: number;
  merged?: boolean;
  reverted?: boolean;
  filesTouched?: number;
  ciStatus?: string;
  actorDeveloperId?: string;
}

export function toLakeOutcomeRow(outcome: OutcomeLike): Record<string, LakeValue> {
  return {
    workspace_id: outcome.workspaceId,
    occurred_at: outcome.occurredAt,
    id: outcome.id,
    project: outcome.project ?? null,
    task_id: outcome.taskId,
    outcome: outcome.outcome,
    send_backs: outcome.sendBacks ?? null,
    merged: outcome.merged ?? null,
    reverted: outcome.reverted ?? null,
    files_touched: outcome.filesTouched ?? null,
    ci_status: outcome.ciStatus ?? null,
    actor_developer_id: outcome.actorDeveloperId === undefined ? null : developerIdHash(outcome.actorDeveloperId),
  };
}

/** `scope`: the source place all of the note's sources share. A note from several places passes undefined and is erased by its id. */
export function toLakeFactRow(fact: RecordFactLike, scope?: string): Record<string, LakeValue> {
  timestampText(fact.createdAt);
  return {
    workspace_id: fact.workspaceId,
    created_at: fact.createdAt,
    id: fact.id,
    project: fact.project ?? null,
    kind: fact.kind,
    text: fact.text,
    links_json: JSON.stringify(fact.links),
    derived_from_json: JSON.stringify(fact.derivedFrom),
    trust: fact.trust,
    audience_kind: fact.audience.kind,
    audience_scope: fact.audience.kind === "restricted" ? fact.audience.acl.scope : null,
    acl_json: fact.audience.kind === "restricted" ? JSON.stringify(lakeAcl(fact.audience.acl)) : null,
    valid_until: fact.validUntil ?? null,
    scope_hash: scope === undefined ? null : scopeHash(scope),
  };
}

export async function appendRows(
  deps: { lake: LakeClient; tableBucket: string },
  table: "outcomes" | "facts",
  rows: ReadonlyArray<Record<string, LakeValue>>,
  rowsPerInsert = 10,
): Promise<{ written: number }> {
  let written = 0;
  for (let i = 0; i < rows.length; i += rowsPerInsert) {
    const batch = rows.slice(i, i + rowsPerInsert);
    const { sql, parameters } = buildInsertIfAbsent(deps.tableBucket, table, batch);
    await deps.lake.execute(sql, parameters);
    written += batch.length;
  }
  return { written };
}

