// S2 (lane team-record-links): whether anyone other than a given person has an edit of an item stored. It answers a yes or no to a tap; no row is ever returned to a viewer.
import { OrgIdSchema } from "@agentx/contracts";
import { bySource } from "./store.js";
import type { PriorEditsPort } from "./sources/ports.js";
import type { TeamRecordTable } from "./types.js";

/** Tombstoned rows count, and so does a list too long to read (fail closed). */
export function priorEditsPort(table: TeamRecordTable): PriorEditsPort {
  return {
    async editedByOthers({ workspaceId, system, id, actorSourceId }) {
      const found = await bySource(table, OrgIdSchema.parse(workspaceId), system, id, 100);
      return found.truncated || found.items.some((item) => item.entityType === "TEAM_RECORD_EVENT" && (item.sourceRef as { order?: unknown } | undefined)?.order !== undefined && (item.actor as { sourceId?: string } | undefined)?.sourceId !== actorSourceId);
    },
  };
}
