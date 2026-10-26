// The changes feed (Plan 5 Task 8): one item per person and notice, kept `CHANGES_FEED_DAYS`, written before the notice is published, so a client that was offline
// catches up with `GET /v1/app/changes?since=<cursor>` and a client that was never told still can be. A feed item holds ids and numbers only, like the notice.
import { createHash } from "node:crypto";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  CHANGES_FEED_DAYS,
  CHANGES_PAGE_MAX,
  CHANGES_SETTLE_MS,
  INDEX_EXPIRY_ATTRIBUTE,
  RealtimeNoticeSchema,
  SessionSharedNoticeSchema,
  CodeSettingsChangedNoticeSchema,
  agentXError,
  changesKey,
  type ChangesFeedEntry,
  type ChangesFeedPage,
  type OrgId,
  type RealtimeNotice,
} from "@agentx/contracts";

export interface ChangesDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

/** One notice for one person. */
export interface FeedEntry { developerId: string; notice: RealtimeNotice; at: string }

const DAY_MS = 86_400_000;
const WRITE_CONCURRENCY = 10;
const CURSOR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#\d{0,6}$/u;

/** Where a notice sorts among the person's notices written in one instant: the same notice gets the same place, so a repeat of a refresh writes the same item. */
export const noticeNumber = (notice: RealtimeNotice): number =>
  Number.parseInt(createHash("sha256").update(JSON.stringify(notice), "utf8").digest("hex").slice(0, 6), 16) % 1_000_000;

/**
 * Writes the entries: each person's notices at `changesKey`, expiring `CHANGES_FEED_DAYS` after the write. A write that fails is counted and logged by error name,
 * never thrown: the feed is a catch-up, and the notice is still published.
 */
export async function writeChanges(deps: ChangesDependencies, orgId: OrgId, entries: readonly FeedEntry[]): Promise<{ written: number; failed: number }> {
  const expires = Math.floor(deps.now() / 1000) + CHANGES_FEED_DAYS * 86_400;
  let written = 0;
  let failed = 0;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const entry = entries[next++];
      if (entry === undefined) return;
      try {
        await deps.documentClient.send(new PutCommand({
          TableName: deps.tableName,
          Item: { ...changesKey(orgId, entry.developerId, entry.at, noticeNumber(entry.notice)), entityType: "CHANGE_NOTICE", orgId, notice: entry.notice, at: entry.at, [INDEX_EXPIRY_ATTRIBUTE]: expires },
        }));
        written += 1;
      } catch (error) {
        failed += 1;
        (deps.log ?? ((line) => console.log(JSON.stringify({ component: "broker", ...line }))))({ event: "realtime.feed_write_failed", error: error instanceof Error ? error.name : "unknown" });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(WRITE_CONCURRENCY, entries.length) }, worker));
  return { written, failed };
}

const refuseCursor = () => agentXError("CONFIG_INVALID", "since: is not a cursor from this feed");

/**
 * `GET /v1/app/changes?since=<cursor>`: the caller's own notices after the cursor, oldest first, at most `CHANGES_PAGE_MAX`; `next` is the cursor to ask with next time.
 * Only notices from the last `CHANGES_FEED_DAYS` are given: the read starts at that age, since a notice past its expiry can still be in the table (deletion lags). A cursor from before that window
 * answers `reset: true` and no notices: the client reloads what it shows and carries on from `next`. No cursor starts at the oldest notice kept.
 *
 * An item's `at` is the summary's `computedAt`, taken before the follower checks and the write, and two writers (the broker and the outbox publisher) write items, so an item can be
 * committed after a newer one was read. `next` is therefore held back: never newer than `CHANGES_SETTLE_MS` before now (and never behind the cursor given, nor past the page's last
 * item), so an item written late is still found by the next read. The cost is repeats: a notice inside the window comes again, with the same `sk`, and the client drops repeats by `sk`.
 * A full page is held back too, except that when the window's edge is no newer than the cursor given its cursor is its last item, or a burst of `CHANGES_PAGE_MAX` notices inside the window could never move on (it costs one repeated page).
 */
export async function readChanges(deps: ChangesDependencies, caller: { orgId: OrgId; developerId: string }, since: string | undefined): Promise<ChangesFeedPage> {
  const now = deps.now();
  const oldest = new Date(now - CHANGES_FEED_DAYS * DAY_MS).toISOString();
  if (since !== undefined && !CURSOR.test(since)) throw refuseCursor();
  const settled = `${new Date(now - CHANGES_SETTLE_MS).toISOString()}#`;
  if (since !== undefined && since.slice(0, 24) < oldest) return { notices: [], next: settled, reset: true };
  const key = changesKey(caller.orgId, caller.developerId, oldest, 0);
  const page = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND sk > :from", ConsistentRead: true, Limit: CHANGES_PAGE_MAX,
    ExpressionAttributeValues: { ":pk": key.pk, ":from": since ?? `${oldest}#` },
  })) as { Items?: Array<Record<string, unknown>> };
  const notices: ChangesFeedEntry[] = [];
  let last: string | undefined;
  for (const item of page.Items ?? []) {
    const sk = item["sk"];
    const at = item["at"];
    if (typeof sk !== "string" || typeof at !== "string") continue;
    last = sk;
    const entry = entryOf(item, at, sk);
    if (entry !== undefined) notices.push(entry);
  }
  if ((page.Items?.length ?? 0) >= CHANGES_PAGE_MAX && last !== undefined) {
    // A full page is held back like any other, so a late item older than its last is still found; but when the edge is no newer than the cursor given, holding back would hand out the
    // same page again, and the page's own last item is the cursor.
    return { notices, next: since !== undefined && settled <= since ? last : last < settled ? last : settled };
  }
  // Nothing came after the cursor: the cursor stands (a feed with no cursor starts at the window's edge). Otherwise the page's last item, held back to the window's edge.
  const held = last === undefined ? since ?? settled : last > settled ? settled : last;
  return { notices, next: since !== undefined && since > held ? since : held };
}

/** A stored item as the feed gives it: a realtime notice, or a share notice, with when it was made. An item that is neither is skipped. */
function entryOf(item: Record<string, unknown>, at: string, sk: string): ChangesFeedEntry | undefined {
  const stored = RealtimeNoticeSchema.safeParse(item["notice"]);
  if (stored.success) return { ...stored.data, at, sk };
  const shared = SessionSharedNoticeSchema.safeParse({ type: item["type"], sessionId: item["sessionId"], revision: item["revision"], by: item["by"], undo: item["undo"] });
  if (shared.success) return { ...shared.data, at, sk };
  const settings = CodeSettingsChangedNoticeSchema.safeParse({ type: item["type"], project: item["project"], revision: item["revision"], by: item["by"] });
  return settings.success ? { ...settings.data, at, sk } : undefined;
}
