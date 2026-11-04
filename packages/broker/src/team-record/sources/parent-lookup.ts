// TR-W1 `ParentLookupPort`: whether a ticket (the parent of a comment) is already recorded under a scope, and whether it was recorded as open. It reads the record's own rows by source
// (an index read, no network call), so a webhook delivery pays no connected-app request and the answer is exactly what the record holds. A lookup that fails, an unknown parent, a
// parent in another place and a parent with any restricted row all mean "no" (the port's callers fail closed: a Linear comment is skipped, a Jira comment is restricted).
import { OrgIdSchema } from "@agentx/contracts";
import { bySource, type TeamRecordTable } from "../store.js";
import type { ParentLookupPort } from "./tickets.js";

/** Rows of one ticket that are read. A ticket with more is not answered "open" (truncated reads fail closed). */
const PARENT_ROWS_MAX = 200;

export function createRecordParentLookup(table: TeamRecordTable): ParentLookupPort {
  async function rowsOf(input: { workspaceId: string; system: string; id: string; scope: string }): Promise<Array<{ structured?: { restricted?: unknown } }> | undefined> {
    const org = OrgIdSchema.safeParse(input.workspaceId);
    if (!org.success) return undefined;
    const found = await bySource(table, org.data, input.system, input.id, PARENT_ROWS_MAX);
    if (found.truncated) return undefined;
    // Only this scope's live ticket rows: a hidden (tombstoned) row is a deleted or erased one, and a row of another place says nothing about this one.
    return found.items.filter((row) => row.entityType === "TEAM_RECORD_EVENT" && row.scope === input.scope && row.tombstone === undefined) as Array<{ structured?: { restricted?: unknown } }>;
  }
  return {
    async isRecorded(input) {
      return ((await rowsOf(input)) ?? []).length > 0;
    },
    // Open only when every live row of the ticket says it was not restricted: a ticket that ever carried a security level stays restricted for its comments.
    async isOpen(input) {
      const rows = (await rowsOf(input)) ?? [];
      return rows.length > 0 && rows.every((row) => row.structured?.restricted === false);
    },
  };
}
