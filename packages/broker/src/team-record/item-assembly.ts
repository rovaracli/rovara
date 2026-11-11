// Per-editor rows (owner, 2026-11-02): a ticket, pull request, review or comment is stored as one row per change, each under the person who made it (`sourceRef.order` marks such a row, and `sourceRef.id`
// is still the item's). A reader that SHOWS an item puts its rows back together here, in order. Only rows the reader may see are put together (each row passes the permission filter on its own), and
// a tombstoned row is never part of it, so an erased person's changes are simply missing from the item and the rest of it reads on.
import { minTrust, type OrgId } from "@rovara-code/contracts";
import { filterVisible, type FilterDependencies } from "./acl.js";
import { bySource, eventFromItem, type StoredEvent } from "./store.js";
import type { ReadAudience, TeamRecordTable } from "./types.js";

/** The most rows of one item put together. */
export const ITEM_ROWS_MAX = 100;

export const isChangeRow = (event: Pick<StoredEvent, "sourceRef">): boolean => event.sourceRef.order !== undefined;

/** The key of the item a change row belongs to. */
export const itemKeyOf = (event: Pick<StoredEvent, "source" | "sourceRef">): string => `${event.source}\u0000${event.sourceRef.system}\u0000${event.sourceRef.id}`;

const byOrder = (left: StoredEvent, right: StoredEvent): number =>
  (left.sourceRef.order ?? 0) - (right.sourceRef.order ?? 0) || left.occurredAt.localeCompare(right.occurredAt) || (left.sourceRef.version ?? "").localeCompare(right.sourceRef.version ?? "") || left.id.localeCompare(right.id);

/**
 * One view of an item from its change rows, oldest first. It is shaped like a row (the first one, which is the item's creation when that is still there): the text is every row's own words in order,
 * the time is the latest change's, the trust is the lowest of the rows put together, and the audience is the narrowest kind among them.
 */
export function assembleItem(rows: readonly StoredEvent[]): StoredEvent {
  const ordered = [...rows].sort(byOrder);
  const first = ordered[0];
  if (first === undefined) throw new Error("an item needs at least one row");
  const texts = ordered.flatMap((row) => (row.text === undefined || row.text === "" ? [] : [row.text]));
  const last = ordered[ordered.length - 1] ?? first;
  const text = texts.join("\n\n");
  const { text: _text, ...rest } = first; // eslint-disable-line @typescript-eslint/no-unused-vars -- replaced below
  return {
    ...rest,
    ...(text === "" ? {} : { text }),
    occurredAt: ordered.reduce((latest, row) => (row.occurredAt > latest ? row.occurredAt : latest), last.occurredAt),
    trust: minTrust(...ordered.map((row) => row.trust)),
    audience: ordered.find((row) => row.audience.kind === "restricted")?.audience ?? first.audience,
  };
}

/** The other rows of the item a change row belongs to that the audience may see, oldest first (including the row itself). Bounded. */
export async function visibleItemRows(table: TeamRecordTable, orgId: OrgId, event: StoredEvent, audience: ReadAudience, filters: FilterDependencies, nowSeconds: number): Promise<StoredEvent[]> {
  const found = await bySource(table, orgId, event.sourceRef.system, event.sourceRef.id, ITEM_ROWS_MAX);
  const rows = found.items
    .map((item) => eventFromItem(item, nowSeconds))
    .filter((row): row is StoredEvent => row !== undefined && row.tombstone === undefined && row.workspaceId === orgId && row.source === event.source && row.project === event.project && isChangeRow(row));
  const visible = (await filterVisible(rows, audience, filters)).visible;
  return visible.sort(byOrder);
}
