// The ONE way a fact is written with an audience that came from an earlier read (review item 3). A fact's audience lists the people who may read it, built from the
// rows it was distilled from; an erase can finish between that read and this write, and the person would be written back with nothing left that points at them. So, like
// a row's put (ingest 7a): the erased markers are read before the write (the list is cleaned), and once more after it (an id erased in between is taken out of the stored
// fact, and the write fails closed if that cannot be done, so the queue redelivers).
import { recordFactKey, type RecordFact } from "@agentx/cloud-contracts";
import { type OrgId } from "@rovara-code/contracts";
import { agentXError } from "@rovara-code/contracts";
import { erasedAccessIds, withoutErasedPrincipals } from "./access.js";
import { removePrincipalsFromRow } from "./scope-work.js";
import { putRecordFact, tombstoneItem } from "./store.js";
import type { TeamRecordTable } from "./types.js";

export async function putFactClean(table: TeamRecordTable, orgId: OrgId, fact: RecordFact, scopes?: readonly string[]): Promise<RecordFact> {
  const clean: RecordFact = { ...fact, audience: await withoutErasedPrincipals(table, orgId, fact.audience) };
  await putRecordFact(table, clean, scopes);
  const written = clean.audience.kind === "restricted" ? clean.audience.acl.principals ?? [] : [];
  if (written.length === 0) return clean;
  const erased = await erasedAccessIds(table, orgId, written);
  if (erased.size === 0) return clean;
  const key = recordFactKey(orgId, fact.project, fact.id);
  if (!(await removePrincipalsFromRow(table, key, erased).catch(() => false))) {
    // Fail closed: hidden before the failure is reported.
    await tombstoneItem(table, key, { at: new Date().toISOString(), cause: "person_erased" }).catch(() => false);
    throw agentXError("RUNTIME_UNAVAILABLE", "A note that names an erased person could not be cleaned right now.");
  }
  return { ...clean, audience: await withoutErasedPrincipals(table, orgId, clean.audience) };
}
