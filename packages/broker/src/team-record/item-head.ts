// Per-item state of the Team record (the ingest lane's sink contract, ports.ts `RecordSinkPort`):
//  - versions are ordered by SOURCE time (`sourceRef.versionAt ?? occurredAt`), never by arrival: a version older than the one stored is a no-op;
//  - a newer version replaces the older one: its text, vector and the notes made from it go (see `supersedeItem` in scope-work.ts);
//  - the LOWEST trust any version ever had is kept (`RecordHistoryPort`), so an outsider's edit of a member's ticket is never relabelled `member` by a later, innocent touch;
//  - a place that was deleted or excluded stays closed: a later put under it, or under a place beneath it, is refused until an admin saves a source row for it again.
// The head is one small item per source item in the workspace partition. It is written BEFORE the row, with a condition on the version time, so two racing versions
// cannot both win; a crash between the two is repaired by the redelivery (same version = same row, and `supersedes` says the cleanup is still owed).
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { minTrust, recordItemHeadKey, recordScopeMarkerKey, scopeAndAncestors, type OrgId, type TrustClass } from "@agentx/contracts";
import { Aliases, errorName, type Item } from "../agents/table-writes.js";
import type { TeamRecordTable } from "./types.js";

const HEAD_GRACE_DAYS = 30;
const DAY_SECONDS = 86_400;

export interface ItemHead {
  versionAt: string;
  version: string;
  lowestTrust: TrustClass;
  /** The newest stored row, when there is one (a retention-B item has none). */
  row?: { pk: string; sk: string };
  /** The row of the version this one replaced, while the cleanup of it is still owed. */
  supersedes?: { row?: { pk: string; sk: string } };
}

export function itemHeadOf(item: Item | undefined): ItemHead | undefined {
  if (item?.entityType !== "TEAM_RECORD_ITEM_HEAD" || typeof item.versionAt !== "string" || typeof item.version !== "string") return undefined;
  const trust = (["outsider", "system", "member", "rovara"] as const).find((candidate) => candidate === item.lowestTrust) ?? "outsider";
  const row = item.row as { pk?: unknown; sk?: unknown } | undefined;
  const supersedes = item.supersedes as { row?: { pk?: unknown; sk?: unknown } } | undefined;
  return {
    versionAt: item.versionAt, version: item.version, lowestTrust: trust,
    ...(typeof row?.pk === "string" && typeof row.sk === "string" ? { row: { pk: row.pk, sk: row.sk } } : {}),
    ...(supersedes === undefined ? {} : { supersedes: typeof supersedes.row?.pk === "string" && typeof supersedes.row.sk === "string" ? { row: { pk: supersedes.row.pk, sk: supersedes.row.sk } } : {} }),
  };
}

export async function getItemHead(table: TeamRecordTable, orgId: OrgId, system: string, sourceId: string): Promise<ItemHead | undefined> {
  const response = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: recordItemHeadKey(orgId, system, sourceId), ConsistentRead: true })) as { Item?: Item };
  return itemHeadOf(response.Item);
}

export type AdvanceOutcome =
  | { status: "stale" }
  /** The same version again (a retry). `owed` is the cleanup of a replaced version that a crash left undone. */
  | { status: "same"; head: ItemHead; owed?: { row?: { pk: string; sk: string } } }
  | { status: "advanced"; lowestTrust: TrustClass; previous: ItemHead | undefined };

/**
 * Whether a version is newer than the head: a later version time, or (equal times) a greater version string. The tie-break is by the version itself, never by arrival,
 * so a redelivery of the lower one is stale in every order and the same version wins everywhere.
 */
export const isNewer = (input: { versionAt: string; version: string }, head: { versionAt: string; version: string }): boolean =>
  input.versionAt > head.versionAt || (input.versionAt === head.versionAt && input.version > head.version);

export const versionTimeOf = (draft: { sourceRef: { versionAt?: string | undefined }; occurredAt: string }): string => new Date(draft.sourceRef.versionAt ?? draft.occurredAt).toISOString();

/**
 * Moves the item to this version, unless a newer one is already there. `row` is where this version's row will be written. The head keeps the lowest trust of every
 * version, including the older ones that arrive late.
 */
export async function advanceItemHead(table: TeamRecordTable, orgId: OrgId, input: { system: string; sourceId: string; version: string; versionAt: string; trust: TrustClass; row?: { pk: string; sk: string }; indexExpiresAt: number }): Promise<AdvanceOutcome> {
  const key = recordItemHeadKey(orgId, input.system, input.sourceId);
  const existing = await getItemHead(table, orgId, input.system, input.sourceId);
  if (existing !== undefined && !isNewer(input, existing) && !(input.versionAt === existing.versionAt && input.version === existing.version)) {
    // A late older version: it cannot replace anything, but what its author was is part of the item's history, and it lowers the trust of the newer row already stored.
    const lower = minTrust(existing.lowestTrust, input.trust);
    if (lower !== existing.lowestTrust) {
      const aliases = new Aliases();
      await table.documentClient.send(new UpdateCommand({
        TableName: table.tableName, Key: key, UpdateExpression: `SET ${aliases.name("lowestTrust")} = ${aliases.value(lower)}`,
        ConditionExpression: `attribute_exists(${aliases.name("pk")})`, ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values,
      })).catch((error: unknown) => { if (errorName(error) !== "ConditionalCheckFailedException") throw error; });
      if (existing.row !== undefined) {
        const rowAliases = new Aliases();
        await table.documentClient.send(new UpdateCommand({
          TableName: table.tableName, Key: existing.row, UpdateExpression: `SET ${rowAliases.name("trust")} = ${rowAliases.value(lower)}`,
          ConditionExpression: `attribute_exists(${rowAliases.name("pk")}) AND attribute_not_exists(${rowAliases.name("tombstone")})`, ExpressionAttributeNames: rowAliases.names, ExpressionAttributeValues: rowAliases.values,
        })).catch((error: unknown) => { if (errorName(error) !== "ConditionalCheckFailedException") throw error; });
      }
    }
    return { status: "stale" };
  }
  if (existing !== undefined && input.versionAt === existing.versionAt && input.version === existing.version) {
    return { status: "same", head: existing, ...(existing.supersedes === undefined ? {} : { owed: existing.supersedes }) };
  }
  const lowest = minTrust(input.trust, ...(existing === undefined ? [] : [existing.lowestTrust]));
  const aliases = new Aliases();
  try {
    await table.documentClient.send(new PutCommand({
      TableName: table.tableName,
      Item: {
        ...key, entityType: "TEAM_RECORD_ITEM_HEAD", versionAt: input.versionAt, version: input.version, lowestTrust: lowest,
        ...(input.row === undefined ? {} : { row: input.row }),
        ...(existing === undefined ? {} : { supersedes: existing.row === undefined ? {} : { row: existing.row } }),
        indexExpiresAt: input.indexExpiresAt + HEAD_GRACE_DAYS * DAY_SECONDS,
      },
      // Only an item that has no head, or whose head is the one we read (or older), may be replaced: a newer version that landed meanwhile wins.
      ConditionExpression: existing === undefined ? `attribute_not_exists(${aliases.name("pk")})`
        : `(${aliases.name("versionAt")} < ${aliases.value(input.versionAt)} OR (${aliases.name("versionAt")} = ${aliases.value(input.versionAt)} AND ${aliases.name("version")} < ${aliases.value(input.version)})) AND ${aliases.name("version")} = ${aliases.value(existing.version)}`,
      ExpressionAttributeNames: aliases.names,
      ...(Object.keys(aliases.values).length === 0 ? {} : { ExpressionAttributeValues: aliases.values }),
    }));
  } catch (error) {
    if (errorName(error) === "ConditionalCheckFailedException") return { status: "stale" };
    throw error;
  }
  return { status: "advanced", lowestTrust: lowest, previous: existing };
}

/** The cleanup of a replaced version is done. */
export async function clearSupersedes(table: TeamRecordTable, orgId: OrgId, system: string, sourceId: string, version: string): Promise<void> {
  const aliases = new Aliases();
  await table.documentClient.send(new UpdateCommand({
    TableName: table.tableName, Key: recordItemHeadKey(orgId, system, sourceId), UpdateExpression: `REMOVE ${aliases.name("supersedes")}`,
    ConditionExpression: `${aliases.name("version")} = ${aliases.value(version)}`, ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values,
  })).catch((error: unknown) => { if (errorName(error) !== "ConditionalCheckFailedException") throw error; });
}

/** Removes a head whose row never got written (the write failed after the head moved and the draft was refused). */
export async function dropItemHead(table: TeamRecordTable, orgId: OrgId, system: string, sourceId: string): Promise<void> {
  await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: recordItemHeadKey(orgId, system, sourceId) }));
}

// ---- closed places

/** Closes a place (and every place under it). Permanent until a source row for it is saved again. */
export async function closeScope(table: TeamRecordTable, orgId: OrgId, scope: string, cause: string, at: string): Promise<void> {
  await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...recordScopeMarkerKey(orgId, scope), entityType: "TEAM_RECORD_SCOPE_CLOSED", scope, cause, at } }));
}

export async function reopenScope(table: TeamRecordTable, orgId: OrgId, scope: string): Promise<void> {
  await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: recordScopeMarkerKey(orgId, scope) }));
}

/** Whether the place, or any place above it, is closed. An unreadable marker throws (the queue redelivers); it is never read as open. */
export async function isScopeClosed(table: TeamRecordTable, orgId: OrgId, scope: string): Promise<boolean> {
  for (const place of scopeAndAncestors(scope)) {
    const response = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: recordScopeMarkerKey(orgId, place), ConsistentRead: true })) as { Item?: Item };
    if (response.Item !== undefined) return true;
  }
  return false;
}
