// S2 (lane team-record-links): whether anyone other than a given person has an edit of an item, STORED OR NOT. It answers a yes or no to a tap; no row is ever returned to a viewer.
//  - a stored change row by someone else (tombstoned ones count) says yes;
//  - so does a mark (`PRIOREDIT#<hash of the item>`, nothing else in it) left when a change to the item was not stored: its person was not linked, was excluded, or was erased (their rows are deleted, and the mark is
//    written first). Whatever those words were, they may sit in the text the author later edits, and nothing stored could say so.
import { createHash } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, teamRecordPk, type OrgId } from "@rovara-code/contracts";
import { bySource } from "./store.js";
import type { PriorEditsPort } from "./sources/ports.js";
import type { TeamRecordTable } from "./types.js";

export const PRIOR_EDIT_PREFIX = "PRIOREDIT#";
const markKey = (orgId: OrgId, item: { source: string; system: string; id: string }): { pk: string; sk: string } => ({ pk: teamRecordPk(orgId), sk: `${PRIOR_EDIT_PREFIX}${createHash("sha256").update(`${item.source}\u0000${item.system}\u0000${item.id}`).digest("hex")}` });

/** Leaves the mark for an item (used by the port, and by a person's erase before it deletes their rows). */
export async function markUnstoredChange(table: TeamRecordTable, orgId: OrgId, item: { source: string; system: string; id: string }, nowMs: number): Promise<void> {
  await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...markKey(orgId, item), entityType: "TEAM_RECORD_PRIOR_EDIT_MARK", orgId, at: new Date(nowMs).toISOString(), indexExpiresAt: Math.floor(nowMs / 1000) + 400 * 86_400 } }));
}

/** Tombstoned rows count, and so does a list too long to read (fail closed). */
export function priorEditsPort(table: TeamRecordTable, now: () => number = Date.now): PriorEditsPort {
  return {
    async editedByOthers({ workspaceId, source, system, id, actorSourceId }) {
      const orgId = OrgIdSchema.parse(workspaceId);
      const marked = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: markKey(orgId, { source, system, id }), ConsistentRead: true }))) as { Item?: unknown }).Item !== undefined;
      if (marked) return true;
      const found = await bySource(table, orgId, system, id, 100);
      return found.truncated || found.items.some((item) => item.entityType === "TEAM_RECORD_EVENT" && (item.sourceRef as { order?: unknown } | undefined)?.order !== undefined && (item.actor as { sourceId?: string } | undefined)?.sourceId !== actorSourceId);
    },
    async noteUnstored({ workspaceId, source, system, id }) {
      await markUnstoredChange(table, OrgIdSchema.parse(workspaceId), { source, system, id }, now());
    },
  };
}
