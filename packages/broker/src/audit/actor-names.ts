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
/** A shown name holds at most 80 characters AND at most 100 UTF-16 units, so the page's own limit (100 units) holds for any name, emoji included. */
const NAME_MAX = 80;
const NAME_UNITS_MAX = 100;
/** How many people are looked up at once (each is up to four consistent reads). */
const LOOKUPS_AT_ONCE = 16;

export function cutName(name: string): string {
  let out = "", units = 0, count = 0;
  for (const character of name) {
    if (count >= NAME_MAX || units + character.length > NAME_UNITS_MAX) break;
    out += character; units += character.length; count += 1;
  }
  return out;
}

export function auditActorNamesFor(reader: AttributionReader, orgId: OrgId): AuditActorNames {
  OrgIdSchema.parse(orgId);
  return async (ids) => {
    const names: Record<string, string> = {};
    const wanted = [...new Set(ids.filter((id) => DEVELOPER_ID.test(id)))].slice(0, MOST_IDS);
    const one = async (id: string): Promise<void> => {
      try {
        if (await reader.isErased(orgId, id)) { names[id] = FORMER_MEMBER; return; }
        const stored = await reader.memberName(orgId, id);
        if (stored === undefined) return;
        names[id] = cutName(safeDisplayName(stored, id));
      } catch { /* this person stays unnamed */ }
    };
    for (let start = 0; start < wanted.length; start += LOOKUPS_AT_ONCE) await Promise.all(wanted.slice(start, start + LOOKUPS_AT_ONCE).map(one));
    return names;
  };
}

/**
 * The reader over the install's tables for the route: the team record's erased markers are consulted only where the team record is on. ERASE-NAME-1: the erase's tombstone in the name item (State table)
 * is consulted everywhere, so an erased person reads "A former member" with the record off too.
 */
export function auditActorNamesOf(input: { documentClient: { send(command: unknown): Promise<unknown> }; stateTable: string; signInTable: string; teamRecordTable: string | undefined; orgId: OrgId }): AuditActorNames {
  const reader = dynamoAttributionReader({ documentClient: input.documentClient, stateTable: input.stateTable, signInTable: input.signInTable, teamRecordTable: input.teamRecordTable ?? "" });
  return auditActorNamesFor(reader, input.orgId);
}
