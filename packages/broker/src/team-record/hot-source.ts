// What the storage lane reads from the hot table (tasks R2/R9 provide it):
//   HotArchiveSource  rows the nightly archiver may move to the lake: listing, a last "still alive?" check, and the mark that says "archived"
//   HotStatsSource    the recent side of the statistics (rows not yet archived), merged with the lake's by the stats runner
//   workspace vector bucket   which vector bucket holds a workspace's index, written once and read back from then on
// The structural shapes below match the storage lane's interfaces (no lane imports another's files). A row with a tombstone is never listed, never counted and is
// never marked archived: the mark is conditional on "no tombstone", so a delete that lands during an archive run wins.
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { RECORD_EVENT_SK_PREFIX, recordEventKey, teamRecordPk, teamRecordSourceHash, workspaceVectorBucketKey, type OrgId, type RecordEvent } from "@agentx/contracts";
import { Aliases, errorName, type Item } from "../agents/table-writes.js";
import { eventFromItem } from "./store.js";
import type { HotArchiveSource } from "./archiver.js";
import type { HotStatsSource } from "./stats-templates.js";
import type { TeamRecordTable } from "./types.js";

// ---- archive

// One definition of each port: the storage lane's (the archiver and the statistics runner declare what they read). This file implements them over the TeamRecord table.
export type { HotArchiveSource } from "./archiver.js";
export type { HotStatsSource } from "./stats-templates.js";

/** The lake delete targets of rows that died while the archiver was copying them (see `markArchived`). */
export interface ArchiveRaceQueue { enqueue(workspaceId: string, targets: Array<{ kind: "source"; sourceHash: string }>): Promise<void> }

/** The org's project names (the catalog the org already keeps). The workspace's project-less partition is always read too. */
export interface ProjectListPort { projects(orgId: OrgId): Promise<string[]> }

interface ArchiveCursor { at: number; last?: Record<string, unknown> }

const encode = (cursor: ArchiveCursor): string => Buffer.from(JSON.stringify(cursor)).toString("base64url");
function decode(value: string | undefined): ArchiveCursor {
  if (value === undefined) return { at: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { at?: unknown; last?: unknown };
    return { at: typeof parsed.at === "number" && Number.isInteger(parsed.at) && parsed.at >= 0 ? parsed.at : 0, ...(typeof parsed.last === "object" && parsed.last !== null ? { last: parsed.last as Record<string, unknown> } : {}) };
  } catch {
    return { at: 0 };
  }
}

/**
 * The archive source of one broker invocation. It remembers where each row it listed lives (id to key) so `filterLive` and `markArchived` can reach them by id;
 * an id it never listed is treated as not live and is never marked (fail closed). Create one per archive run.
 */
export function tableHotArchiveSource(table: TeamRecordTable, projectsPort: ProjectListPort, lakeQueue: ArchiveRaceQueue, now: () => number = Date.now): HotArchiveSource {
  const keys = new Map<string, { pk: string; sk: string }>();
  const sourceHashes = new Map<string, string>();
  const keyOf = (orgId: OrgId, id: string) => keys.get(`${orgId}|${id}`);
  return {
    async listArchivable(request) {
      const orgId = request.workspaceId;
      const partitions: Array<string | undefined> = [...(await projectsPort.projects(orgId)).sort(), undefined];
      const cursor = decode(request.cursor);
      const upper = `${RECORD_EVENT_SK_PREFIX}${new Date(request.olderThan).toISOString()}`;
      const rows: RecordEvent[] = [];
      let at = cursor.at;
      let last = cursor.last;
      while (at < partitions.length && rows.length < request.limit) {
        const page = await table.documentClient.send(new QueryCommand({
          TableName: table.tableName,
          KeyConditionExpression: "pk = :pk AND sk BETWEEN :low AND :high",
          ExpressionAttributeValues: { ":pk": teamRecordPk(orgId, partitions[at]), ":low": RECORD_EVENT_SK_PREFIX, ":high": upper },
          Limit: Math.min(request.limit - rows.length, 100),
          ...(last === undefined ? {} : { ExclusiveStartKey: last }),
        })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
        for (const item of page.Items ?? []) {
          if (item.tombstone !== undefined || item.archivedAt !== undefined) continue;
          const event = eventFromItem(item, Math.floor(now() / 1000));
          if (event === undefined || event.workspaceId !== orgId) continue;
          // Raw text reaches the lake only under D. A C row whose text is still there (the expiry job has not run) goes without it.
          if (event.retention !== "D" && event.text !== undefined) { const { text: _text, textExpiresAt: _expires, ...bare } = event; rows.push(bare); } else rows.push(event); // eslint-disable-line @typescript-eslint/no-unused-vars -- dropped on purpose
          sourceHashes.set(`${orgId}|${event.id}`, teamRecordSourceHash(event.sourceRef.system, event.sourceRef.id));
          keys.set(`${orgId}|${event.id}`, recordEventKey(orgId, event.project, event.occurredAt, event.id));
        }
        last = page.LastEvaluatedKey;
        if (last === undefined) at += 1;
      }
      return at >= partitions.length ? { rows } : { rows, nextCursor: encode({ at, ...(last === undefined ? {} : { last }) }) };
    },

    async filterLive(workspaceId, ids) {
      const live = new Set<string>();
      for (const id of ids) {
        const key = keyOf(workspaceId, id);
        if (key === undefined) continue;
        const response = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true })) as { Item?: Item };
        if (response.Item !== undefined && response.Item.tombstone === undefined) live.add(id);
      }
      return live;
    },

    async markArchived(workspaceId, ids, archivedAt) {
      const lost: string[] = [];
      for (const id of ids) {
        const key = keyOf(workspaceId, id);
        if (key === undefined) continue;
        const aliases = new Aliases();
        try {
          await table.documentClient.send(new UpdateCommand({
            TableName: table.tableName,
            Key: key,
            UpdateExpression: `SET ${aliases.name("archivedAt")} = ${aliases.value(archivedAt)}`,
            // A row that died since the last check is not marked: the delete wins.
            ConditionExpression: `attribute_exists(${aliases.name("pk")}) AND attribute_not_exists(${aliases.name("tombstone")})`,
            ExpressionAttributeNames: aliases.names,
            ExpressionAttributeValues: aliases.values,
          }));
        } catch (error) {
          if (errorName(error) !== "ConditionalCheckFailedException") throw error;
          // The row was deleted after the last check, so the lake copy the archiver just wrote must go too: the hourly lake delete for it may already have run.
          lost.push(id);
        }
      }
      const targets = lost.flatMap((id) => { const hash = sourceHashes.get(`${workspaceId}|${id}`); return hash === undefined ? [] : [{ kind: "source" as const, sourceHash: hash }]; });
      if (targets.length > 0) await lakeQueue.enqueue(workspaceId, targets);
      return lost;
    },
  };
}

// ---- statistics (the recent side)


/** The most rows one statistic reads from the hot table. A window with more is cut (newest rows kept) and the totals are lower bounds. */
export const HOT_STATS_MAX_ROWS = 20_000;

const GROUPS: Record<string, { kind: string; field: string; where?: (structured: Record<string, string | number | boolean>) => boolean }> = {
  send_backs_by_stage: { kind: "rovara.send_back", field: "stage" },
  tickets_by_component: { kind: "ticket.created", field: "component" },
  ci_failures_by_test: { kind: "github.ci", field: "check", where: (structured) => structured.conclusion === "failure" },
};

async function recentRows(table: TeamRecordTable, orgId: OrgId, project: string, since: string, until: string): Promise<RecordEvent[]> {
  const events: RecordEvent[] = [];
  let start: Record<string, unknown> | undefined;
  while (events.length < HOT_STATS_MAX_ROWS) {
    const page = await table.documentClient.send(new QueryCommand({
      TableName: table.tableName,
      KeyConditionExpression: "pk = :pk AND sk BETWEEN :low AND :high",
      ExpressionAttributeValues: { ":pk": teamRecordPk(orgId, project), ":low": `${RECORD_EVENT_SK_PREFIX}${new Date(since).toISOString()}`, ":high": `${RECORD_EVENT_SK_PREFIX}${new Date(Date.parse(until) - 1).toISOString()}￿` },
      ScanIndexForward: false,
      Limit: 500,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      // Project-wide rows only (a restricted source never shows through a total), not deleted, not yet in the lake.
      if (item.tombstone !== undefined || item.archivedAt !== undefined) continue;
      const event = eventFromItem(item);
      if (event !== undefined && event.workspaceId === orgId && event.audience.kind === "project") events.push(event);
    }
    start = page.LastEvaluatedKey;
    if (start === undefined) break;
  }
  return events;
}

/** SRL-4: the task a Rovara row is about (its structured `taskId`). */
const taskOf = (event: RecordEvent): string | undefined => (typeof event.structured?.taskId === "string" && event.structured.taskId !== "" ? event.structured.taskId : undefined);
/** SRL-4: whether a statistic counts this row. With a list of tasks that may be counted, a Rovara row counts only when it names a task on it. */
const countable = (event: RecordEvent, allowed: ReadonlySet<string> | undefined): boolean => {
  if (allowed === undefined || event.source !== "rovara") return true;
  const task = taskOf(event);
  return task !== undefined && allowed.has(task);
};

export function tableHotStatsSource(table: TeamRecordTable): HotStatsSource {
  return {
    async groupedCounts(request) {
      const spec = GROUPS[request.template];
      if (spec === undefined) throw new Error("team-record stats: no hot side for that template");
      const counts = new Map<string, number>();
      const allowed = request.onlyTaskIds === undefined ? undefined : new Set(request.onlyTaskIds);
      for (const event of await recentRows(table, request.workspaceId, request.project, request.since, request.until)) {
        if (event.kind !== spec.kind || (spec.where !== undefined && !spec.where(event.structured ?? {})) || !countable(event, allowed)) continue;
        const value = event.structured?.[spec.field];
        const group = typeof value === "string" && value.length > 0 ? value : "unknown";
        counts.set(group, (counts.get(group) ?? 0) + 1);
      }
      return [...counts.entries()].map(([group, count]) => ({ group, count })).sort((a, b) => b.count - a.count || (a.group < b.group ? -1 : 1));
    },
    async mergeTotals(request) {
      const totals = { tasks: 0, merged: 0, reverted: 0, send_backs: 0 };
      const allowed = request.onlyTaskIds === undefined ? undefined : new Set(request.onlyTaskIds);
      for (const event of await recentRows(table, request.workspaceId, request.project, request.since, request.until)) {
        if (event.kind !== "rovara.task" || !countable(event, allowed)) continue;
        totals.tasks += 1;
        if (event.structured?.outcome === "merged") totals.merged += 1;
        if (event.structured?.outcome === "reverted") totals.reverted += 1;
        const sendBacks = event.structured?.sendBacks;
        if (typeof sendBacks === "number" && Number.isFinite(sendBacks) && sendBacks > 0) totals.send_backs += sendBacks;
      }
      return totals;
    },
    async rovaraTaskIds(request) {
      const kind = request.template === "send_backs_by_stage" ? "rovara.send_back" : request.template === "rovara_merge_rate" ? "rovara.task" : undefined;
      if (kind === undefined) throw new Error("team-record stats: no Rovara rows are counted for that template");
      const ids = new Set<string>();
      for (const event of await recentRows(table, request.workspaceId, request.project, request.since, request.until)) {
        const task = event.kind === kind ? taskOf(event) : undefined;
        if (task !== undefined) ids.add(task);
      }
      return [...ids];
    },
  };
}

// ---- the vector bucket of a workspace

/** The bucket recorded for a workspace, or undefined if none was assigned yet. */
export async function getWorkspaceVectorBucket(table: TeamRecordTable, orgId: OrgId): Promise<string | undefined> {
  const response = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: workspaceVectorBucketKey(orgId), ConsistentRead: true })) as { Item?: Item };
  return typeof response.Item?.bucket === "string" ? response.Item.bucket : undefined;
}

/**
 * The workspace's bucket: the stored one, or, the first time, the one `choose` picks from `buckets`, written only if still absent (two first calls agree on the
 * winner). It is never changed afterwards, so adding a bucket later cannot remap a workspace and orphan its vectors.
 */
export async function ensureWorkspaceVectorBucket(table: TeamRecordTable, orgId: OrgId, buckets: readonly string[], choose: (workspaceId: string, buckets: readonly string[]) => string, now: () => number = Date.now): Promise<string> {
  const stored = await getWorkspaceVectorBucket(table, orgId);
  if (stored !== undefined) return stored;
  const picked = choose(orgId, buckets);
  if (!buckets.includes(picked)) throw new Error("team-record: the chosen vector bucket is not one of the configured buckets");
  try {
    await table.documentClient.send(new PutCommand({
      TableName: table.tableName,
      Item: { ...workspaceVectorBucketKey(orgId), entityType: "TEAM_RECORD_VECTOR_BUCKET", bucket: picked, assignedAt: new Date(now()).toISOString() },
      ConditionExpression: "attribute_not_exists(pk)",
    }));
    return picked;
  } catch (error) {
    if (errorName(error) !== "ConditionalCheckFailedException") throw error;
    const winner = await getWorkspaceVectorBucket(table, orgId);
    if (winner === undefined) throw new Error("team-record: the vector bucket assignment can't be read", { cause: error });
    return winner;
  }
}
