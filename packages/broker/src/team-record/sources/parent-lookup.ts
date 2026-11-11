// TR-W1 `ParentLookupPort`: whether a ticket (the parent of a comment) is already recorded under a scope (Linear comments are kept only then). It reads the record's own rows by source
// (an index read, no network call), so a webhook delivery pays no connected-app request and the answer is exactly what the record holds. A lookup that fails, an unknown parent and a
// parent in another place all mean "no" (the port's callers fail closed: a Linear comment is skipped). Whether a parent is OPEN is not answered here, see below.
import { OrgIdSchema } from "@rovara-code/contracts";
import { bySource } from "../store.js";
import type { TeamRecordTable } from "../types.js";
import type { ParentLookupPort } from "./tickets.js";

/** Rows of one ticket that are read. A truncated read answers "not recorded" (fail closed). */
const PARENT_ROWS_MAX = 200;

export function createRecordParentLookup(table: TeamRecordTable): ParentLookupPort {
  async function rowsOf(input: { workspaceId: string; system: string; id: string; scope: string }): Promise<Array<{ structured?: { restricted?: unknown } }> | undefined> {
    const org = OrgIdSchema.safeParse(input.workspaceId);
    if (!org.success) return undefined;
    const found = await bySource(table, org.data, input.system, input.id, PARENT_ROWS_MAX);
    if (found.truncated) return undefined;
    // Only this scope's live ticket rows: a hidden (tombstoned) row is a deleted or erased one, and a row of another place says nothing about this one.
    return found.items.filter((row) => row.entityType === "TEAM_RECORD_EVENT" && row.scope === input.scope && row.tombstone === undefined);
  }
  return {
    async isRecorded(input) {
      return ((await rowsOf(input)) ?? []).length > 0;
    },
    // There is deliberately no `isOpen`: the record knows only the restrictions it STORED. A security level set by someone whose change was refused, excluded or lost would leave an open row behind,
    // and a Jira comment on that issue would then be taken as open. Without `isOpen` every Jira comment is restricted (maintainers only), as it was before this port existed.
  };
}
