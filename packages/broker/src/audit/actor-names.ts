// QA6-09: the Audit page names the members its records are about. A record holds a person's opaque id (the ledger keeps no name outside its sealed details), so the page asks for the names now, the same way a task's
// attribution does (`attribution/resolve.ts`): the display name the company already shows (never an email address), only for a person who is or was one of THIS org's people, and "A former member" for a person
// who was erased. An id the org does not know, or one that cannot be read, is left out (the page then shows the record's own words). A name is never written to the ledger or a log.
import { OrgIdSchema, type OrgId } from "@agentx/contracts";
import { safeDisplayName } from "../developer/person-name.js";
import { dynamoAttributionReader, type AttributionReader } from "../attribution/resolve.js";
import type { AuditActorNames } from "./routes.js";

const DEVELOPER_ID = /^[a-f0-9]{64}$/u;
/** The most ids named for one page (the page holds at most 200 records, so at most 400 ids). */
const MOST_IDS = 400;
export const FORMER_MEMBER = "A former member";
const NAME_MAX = 80;

export function auditActorNamesFor(reader: AttributionReader, orgId: OrgId): AuditActorNames {
  OrgIdSchema.parse(orgId);
  return async (ids) => {
    const names: Record<string, string> = {};
    await Promise.all(ids.filter((id) => DEVELOPER_ID.test(id)).slice(0, MOST_IDS).map(async (id) => {
      try {
        if (await reader.isErased(orgId, id)) { names[id] = FORMER_MEMBER; return; }
        const stored = await reader.memberName(orgId, id);
        if (stored === undefined) return;
        names[id] = Array.from(safeDisplayName(stored, id)).slice(0, NAME_MAX).join("");
      } catch { /* this person stays unnamed */ }
    }));
    return names;
  };
}

/** The reader over the install's tables for the route: the team record's erased markers are consulted only where the team record is on. */
export function auditActorNamesOf(input: { documentClient: { send(command: unknown): Promise<unknown> }; stateTable: string; signInTable: string; teamRecordTable: string | undefined; orgId: OrgId }): AuditActorNames {
  const reader = dynamoAttributionReader({ documentClient: input.documentClient, stateTable: input.stateTable, signInTable: input.signInTable, teamRecordTable: input.teamRecordTable ?? "" });
  const erased = input.teamRecordTable === undefined ? { ...reader, isErased: async () => false } : reader;
  return auditActorNamesFor(erased, input.orgId);
}
