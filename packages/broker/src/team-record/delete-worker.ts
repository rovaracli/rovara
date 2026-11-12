// The delete worker (design 4.4.3, task D1): finishes the work a tombstone request queued. It runs hourly per workspace (EventBridge Scheduler plus Lambda).
// For each queued request it (1) finishes hiding, (2) removes the hot rows, vectors and derived facts and queues the lake delete, (3) settles the lessons that rested
// on them, and (4) removes the queue item. Work on a scope that has not finished hiding stays queued with `hidePending`, which keeps the scope hidden from everyone.
// A deleted place (`source_deleted`, `excluded`) also loses its item heads (TR-E5). A `textOnly` request (a removed Rovara source row) removes only the rows that hold free text, walking the place from `walkCursor`.
// Principal and audience changes that ran out of budget are finished here too. Every run is bounded (requests, items, milliseconds). A request older than an hour is a
// backlog: the summary says so and the log line is the alarm; hidden rows stay hidden meanwhile.
import { recordDeleteQueueKey, recordItemHeadKey, recordScopeHash, teamRecordSourceHash } from "@agentx/cloud-contracts";
import { type OrgId } from "@rovara-code/contracts";
import { auditRecordTombstoned, type RecordAuditSink } from "./audit.js";
import { purgeAccessOfScope } from "./access.js";
import { runErasureSweeps } from "./erase.js";
import { closeScope } from "./item-head.js";
import { tableLakeDeleteQueue } from "./lake-queue.js";
import { emptyPurge, purgeItems, type PurgeDependencies, type PurgeResult } from "./purge.js";
import { changeScopePrincipals, replaceScopeAudience, tombstoneRows, type WorkBudget } from "./scope-work.js";
import { DeleteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { bySource, byScope, childScopes, deleteItem, listScopeWork, rewriteScopeWork, scopePage, type PlaceCursor, type ScopeWork } from "./store.js";
import { Aliases, errorName, type Item } from "../agents/table-writes.js";
import { recordOpsFailure } from "./ops-failures.js";

/** A request older than this many seconds is a backlog (design: hot rows are deleted within 1 hour). */
export const DELETE_BACKLOG_SECONDS = 3_600;

export interface DeleteBudget extends WorkBudget {
  /** The most queue items one run takes. */
  maxRequests: number;
}
export const DEFAULT_DELETE_BUDGET: DeleteBudget = { maxRequests: 50, maxItems: 5_000, maxMs: 20_000 };

export interface DeleteWorkerDependencies extends PurgeDependencies {
  audit?: RecordAuditSink | undefined;
}

export interface DeleteRunSummary extends PurgeResult {
  requests: number;
  finished: number;
  stillHidden: number;
  /** True when some request is older than an hour. */
  backlog: boolean;
  oldestAgeSeconds: number;
  /** Second passes of completed erasures: how many ran and how many became final. */
  erasureSweeps?: { ran: number; final: number };
  /** TR-E2b: 1 when the second-pass step itself failed this run (the next run tries it again); 0 otherwise. The hourly job's details carry it. */
  sweepFailed: number;
}

/** The index items a request names: the rows and derivation links of its source items or scope. `truncated` means the budget cut the list. */
async function itemsOf(deps: DeleteWorkerDependencies, orgId: OrgId, work: ScopeWork, budget: WorkBudget): Promise<{ items: Item[]; truncated: boolean }> {
  const items: Item[] = [];
  let truncated = false;
  for (const sourceId of (work.sourceIds ?? []).slice(0, 500)) {
    const found = await bySource(deps.table, orgId, work.system, sourceId, budget.maxItems);
    items.push(...found.items);
    truncated ||= found.truncated;
  }
  if (work.scope !== undefined) {
    const found = await byScope(deps.table, orgId, work.scope, budget.maxItems);
    items.push(...found.items);
    truncated ||= found.truncated;
  }
  return { items: [...new Map(items.map((item) => [`${item.pk as string}|${item.sk as string}`, item])).values()], truncated };
}

export async function runDeleteWorker(deps: DeleteWorkerDependencies, orgId: OrgId, budget: DeleteBudget = DEFAULT_DELETE_BUDGET): Promise<DeleteRunSummary> {
  const now = deps.now ?? Date.now;
  const started = now();
  const summary: DeleteRunSummary = { ...emptyPurge(), requests: 0, finished: 0, stillHidden: 0, backlog: false, oldestAgeSeconds: 0, sweepFailed: 0 };
  // The second pass of erasures that reported complete (due ones only): an erase is final only after it.
  // A failure here must not stop the rest of the run, and must not pass unseen: a fixed-code log and a count (the sweep items stay, so the next run tries again).
  try { summary.erasureSweeps = await runErasureSweeps(deps, orgId, now()); } catch {
    summary.erasureSweeps = { ran: 0, final: 0 };
    summary.sweepFailed = 1;
    deps.log?.("record.erase_sweep_failed", { count: 1 });
    // SRL-6: counted for the company's Health page (best effort, no text).
    await recordOpsFailure(deps.table, orgId, "erase_sweep", now());
  }
  const work = await listScopeWork(deps.table, orgId, budget.maxRequests);
  const work0 = { table: deps.table, now };
  for (let entry of work) {
    summary.oldestAgeSeconds = Math.max(summary.oldestAgeSeconds, Math.max(0, Math.floor(now() / 1000) - entry.queuedAtSeconds));
    if (now() - started >= budget.maxMs) break;
    summary.requests += 1;
    const remaining: WorkBudget = { maxItems: budget.maxItems, maxMs: Math.max(1, budget.maxMs - (now() - started)) };
    const key = recordDeleteQueueKey(orgId, entry.at, entry.requestId);

    if (entry.type === "principals" || entry.type === "audience") {
      const done = entry.type === "principals"
        ? await changeScopePrincipals(work0, orgId, { scope: entry.scope ?? "", ...(entry.add === undefined ? {} : { add: entry.add }), ...(entry.remove === undefined ? {} : { remove: entry.remove }), at: entry.changeAt ?? entry.at }, remaining, entry.walkCursor)
        : await replaceScopeAudience(work0, orgId, { scope: entry.scope ?? "", audience: entry.audience as never, at: entry.changeAt ?? entry.at }, remaining, entry.walkCursor);
      if (done.complete) { await deleteItem(deps.table, key); summary.finished += 1; } else {
        // Go on from here next time, not from the start of the place.
        await rewriteScopeWork(deps.table, orgId, { ...entry, hidePending: true, ...(done.cursor === undefined ? {} : { walkCursor: done.cursor }) });
        summary.stillHidden += 1;
      }
      continue;
    }

    if (entry.type === "replaced") {
      // Older versions of an item that a newer version replaced (already hidden): remove their rows and vectors, and the notes made from the item before this was queued.
      const rows: Item[] = [];
      for (const rowKey of entry.rowKeys ?? []) {
        const response = await deps.table.documentClient.send(new GetCommand({ TableName: deps.table.tableName, Key: rowKey, ConsistentRead: true })) as { Item?: Item };
        if (response.Item !== undefined) rows.push(response.Item);
      }
      const links: Item[] = [];
      for (const sourceId of entry.sourceIds ?? []) {
        const found = await bySource(deps.table, orgId, entry.system, sourceId, remaining.maxItems);
        // Notes made after the replacement belong to the new version and stay.
        links.push(...found.items.filter((item) => item.entityType === "TEAM_RECORD_DERIVATION" && item.tombstone !== undefined && typeof item.createdAt === "string" && item.createdAt <= entry.at));
      }
      const purged = await purgeItems(deps, orgId, [...rows, ...links]);
      summary.rows += purged.rows; summary.facts += purged.facts; summary.redistilled += purged.redistilled; summary.vectors += purged.vectors;
      summary.lessonsWithdrawn += purged.lessonsWithdrawn; summary.lessonsKept += purged.lessonsKept; summary.blocked += purged.blocked;
      if (purged.blocked === 0) { await deleteItem(deps.table, key); summary.finished += 1; } else summary.stillHidden += 1;
      continue;
    }

    // A place whose sink call stopped early (childPending is still set): the sink writes the queue item first, so it may not have closed the place or queued its own lake target
    // yet. Both are repeatable, so the worker does them before anything is purged.
    if (entry.scope !== undefined && entry.childPending === true) {
      try {
        if (entry.cause === "source_deleted" || entry.cause === "excluded") await closeScope(deps.table, orgId, entry.scope, entry.cause, new Date(now()).toISOString());
        await (deps.lakeQueue ?? tableLakeDeleteQueue(deps.table, deps.now)).enqueue(orgId, [{ kind: "scope", hash: recordScopeHash(entry.scope) }]);
      } catch {
        deps.log?.("record.delete_children_unavailable", {});
        summary.stillHidden += 1;
        continue;
      }
    }
    // A tombstone request: finish hiding (a busy place is walked from its cursor, never from the start), queue the lake targets of the places below it, then delete.
    if (entry.hideDone !== true) {
      const hidden = await tombstoneRows(work0, orgId, { system: entry.system, ...(entry.scope === undefined ? {} : { scope: entry.scope }), ...(entry.sourceIds === undefined ? {} : { sourceIds: entry.sourceIds }), cause: entry.cause ?? "source_deleted", ...(entry.textOnly === true ? { textOnly: true } : {}) }, remaining, entry.hideCursor);
      if (!hidden.complete) {
        await rewriteScopeWork(deps.table, orgId, { ...entry, hidePending: true, ...(hidden.cursor === undefined ? {} : { hideCursor: hidden.cursor }) });
        summary.stillHidden += 1;
        continue;
      }
      const { hideCursor: _done, ...rest } = entry; // eslint-disable-line @typescript-eslint/no-unused-vars -- dropped on purpose
      // A text-only request has hidden every row it will delete: the rest of the place (its structured rows) is readable again.
      entry = { ...rest, hideDone: true, ...(entry.textOnly === true ? { hidePending: false } : {}) };
      await rewriteScopeWork(deps.table, orgId, entry);
    }
    if (entry.scope !== undefined && (entry.childPending === true || entry.childCursor !== undefined)) {
      // "Pending with no cursor" means no page was queued yet (the sink may have stopped before its first): start from the first page. The scan is done only when a page
      // comes back with no cursor, and only then is childPending cleared; until then no row of this request is purged.
      let cursor: PlaceCursor | undefined = entry.childCursor;
      let finished: boolean;
      try {
        do {
          const page = await childScopes(deps.table, orgId, entry.scope, { limit: 500, ...(cursor === undefined ? {} : { cursor }) });
          if (page.scopes.length > 0) await (deps.lakeQueue ?? tableLakeDeleteQueue(deps.table, deps.now)).enqueue(orgId, page.scopes.map((place) => ({ kind: "scope" as const, hash: recordScopeHash(place) })));
          cursor = page.cursor;
          finished = cursor === undefined;
        } while (!finished && now() - started < budget.maxMs);
      } catch {
        // The lake queue or the index cannot be reached: nothing is purged, the item and its flag stay, and the next run starts again from the cursor.
        deps.log?.("record.delete_children_unavailable", {});
        summary.stillHidden += 1;
        continue;
      }
      const { childCursor: _gone, ...rest } = entry; // eslint-disable-line @typescript-eslint/no-unused-vars -- dropped on purpose
      entry = finished ? { ...rest, childPending: false } : { ...entry, childPending: true, ...(cursor === undefined ? {} : { childCursor: cursor }) };
      await rewriteScopeWork(deps.table, orgId, entry);
      if (!finished) { summary.stillHidden += 1; continue; }
    }
    // Source ids that never had a row in the hot table may still have lake rows: their hashes are queued first, before any hot row goes.
    if (entry.sourceIds !== undefined) await queueNamedSources(deps, orgId, entry);
    // A place whose text rows only go (a removed Rovara source row) walks the place page by page from `walkCursor`: its other rows stay, so the first rows of the place are not always the ones that go.
    let found: { items: Item[]; truncated: boolean };
    let nextWalk: ScopeWork["walkCursor"];
    if (entry.textOnly === true && entry.scope !== undefined) {
      const page = await scopePage(deps.table, orgId, entry.scope, remaining.maxItems, { ...(entry.walkCursor === undefined ? {} : { cursor: entry.walkCursor }) });
      found = { items: page.items.filter((item) => item.tombstone !== undefined && (item.entityType === "TEAM_RECORD_EVENT" || item.entityType === "TEAM_RECORD_DERIVATION")), truncated: page.cursor !== undefined };
      nextWalk = page.cursor;
    } else found = await itemsOf(deps, orgId, entry, remaining);
    const purged = await purgeItems(deps, orgId, found.items);
    summary.rows += purged.rows; summary.facts += purged.facts; summary.redistilled += purged.redistilled; summary.vectors += purged.vectors;
    summary.lessonsWithdrawn += purged.lessonsWithdrawn; summary.lessonsKept += purged.lessonsKept; summary.blocked += purged.blocked;
    // The deleted place keeps no member list (the place stays closed, so nothing reads it again): its entries go a few thousand a run, and the request stays until they are gone.
    const scopeDeleted = entry.scope !== undefined && entry.textOnly !== true && (entry.cause === "source_deleted" || entry.cause === "excluded");
    // TR-E5: the item heads of a deleted place go with it (the index finds a head by its place; a row's own head is found by the row's source item). A head holds a hash and a time, no text,
    // and nothing reads it once the place is closed, so it goes even when a row of the batch is blocked.
    const headsLeft = scopeDeleted ? await deleteItemHeads(deps, orgId, entry.scope as string, found.items, remaining.maxItems) : false;
    // The units under the place (an issue, a comment, an MCP item: each has its own record) are named by the rows' own snapshots; they go with the rows, in the same run.
    let unitsGone = true;
    if (scopeDeleted) {
      const units = new Set(found.items.flatMap((item) => { const scope = (item.audience as { acl?: { scope?: unknown } } | undefined)?.acl?.scope; return item.entityType === "TEAM_RECORD_EVENT" && typeof scope === "string" && scope !== entry.scope ? [scope] : []; }));
      for (const unit of units) unitsGone = (await purgeAccessOfScope(deps.table, orgId, unit, remaining.maxItems)) && unitsGone;
    }
    const accessGone = scopeDeleted && purged.blocked === 0 && !found.truncated ? (await purgeAccessOfScope(deps.table, orgId, entry.scope as string, remaining.maxItems)) && unitsGone : unitsGone;
    if (nextWalk !== undefined && purged.blocked === 0) {
      // Not at the end of the place yet: go on from here next time.
      await rewriteScopeWork(deps.table, orgId, { ...entry, hidden: entry.hidden + purged.rows, walkCursor: nextWalk });
      summary.stillHidden += 1;
    } else if (purged.blocked === 0 && !found.truncated && accessGone && !headsLeft) {
      await deps.audit?.(auditRecordTombstoned({ orgId, requestId: entry.requestId, at: new Date(now()).toISOString(), scopeOrSource: entry.scope ?? entry.system, cause: entry.cause ?? "source_deleted", count: purged.rows + purged.facts })).catch(() => undefined);
      await deleteItem(deps.table, key);
      summary.finished += 1;
    } else {
      // Not finished: keep the request, and the scope stays hidden until it is. The next run continues.
      await rewriteScopeWork(deps.table, orgId, { ...entry, hidePending: entry.scope !== undefined && entry.textOnly !== true ? true : entry.hidePending, hidden: entry.hidden + purged.rows });
      summary.stillHidden += 1;
    }
  }
  summary.backlog = summary.oldestAgeSeconds > DELETE_BACKLOG_SECONDS;
  if (summary.backlog) deps.log?.("record.delete_backlog", { requests: summary.requests, oldestAgeSeconds: summary.oldestAgeSeconds });
  return summary;
}

/**
 * Deletes the item heads of a deleted place: the head of every row in the batch (found by the row's source item, which also reaches heads written before they carried a place), and a
 * budget's worth of the heads indexed under the place (those of retention-B items, which have no row). True when more of those are left: the request then stays and the next run
 * takes the next page (the deleted ones are gone, so it needs no cursor).
 */
async function deleteItemHeads(deps: DeleteWorkerDependencies, orgId: OrgId, scope: string, items: readonly Item[], maxItems: number): Promise<boolean> {
  const keys = new Map<string, { pk: string; sk: string }>();
  // A head found through a row belongs to the item, which may have moved to another place since (a newer version lives there): it goes only if it names no place or this one.
  const rowHeads = new Map<string, { pk: string; sk: string }>();
  for (const item of items) {
    if (item.entityType !== "TEAM_RECORD_EVENT") continue;
    const source = item.sourceRef as { system?: unknown; id?: unknown } | undefined;
    if (typeof source?.system === "string" && typeof source.id === "string") { const key = recordItemHeadKey(orgId, source.system, source.id); rowHeads.set(`${key.pk}|${key.sk}`, key); }
  }
  const page = await scopePage(deps.table, orgId, scope, maxItems, { heads: true });
  for (const item of page.items) if (item.entityType === "TEAM_RECORD_ITEM_HEAD" && typeof item.pk === "string" && typeof item.sk === "string") keys.set(`${item.pk}|${item.sk}`, { pk: item.pk, sk: item.sk });
  for (const key of keys.values()) await deleteItem(deps.table, key);
  for (const [id, key] of rowHeads) if (!keys.has(id)) await deleteHeadInPlace(deps, key, scope);
  return page.cursor !== undefined;
}

async function deleteHeadInPlace(deps: DeleteWorkerDependencies, key: { pk: string; sk: string }, scope: string): Promise<void> {
  const aliases = new Aliases();
  try {
    await deps.table.documentClient.send(new DeleteCommand({
      TableName: deps.table.tableName, Key: key,
      ConditionExpression: `attribute_not_exists(${aliases.name("scope")}) OR ${aliases.name("scope")} = ${aliases.value(scope)} OR begins_with(${aliases.name("scope")}, ${aliases.value(`${scope}/`)})`,
      ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values,
    }));
  } catch (error) {
    if (errorName(error) !== "ConditionalCheckFailedException") throw error; // the item lives in another place now: its head stays
  }
}

async function queueNamedSources(deps: DeleteWorkerDependencies, orgId: OrgId, entry: ScopeWork): Promise<void> {
  const queue = deps.lakeQueue ?? tableLakeDeleteQueue(deps.table, deps.now);
  await queue.enqueue(orgId, (entry.sourceIds ?? []).slice(0, 500).map((sourceId) => ({ kind: "source" as const, sourceHash: teamRecordSourceHash(entry.system, sourceId) })));
}
