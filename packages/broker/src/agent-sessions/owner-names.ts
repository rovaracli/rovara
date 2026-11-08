// Release 0.4.18: a session stores its owner's name as it was when the session started, which for work begun before a person chose their name is the placeholder.
// What a screen shows is the chosen name now (the State item `DEVELOPER_NAME#<id>`, see developer/chosen-name.ts), read by the stored owner's id, never by the stored name.
// Best effort: a State read that fails never fails the page; it shows a generic name (`UNAVAILABLE_NAME`), not the stored one, which may be an erased person's. Names go through the email-safe rule in `readChosenNames`.
import { readNameItems, chosenNameStatesOf } from "../developer/chosen-name.js";
import { NameReplacements, UNAVAILABLE_NAME, logNameLookupFailure, replacementNamesFrom, shownNameOf } from "../developer/name-resolver.js";

export interface OwnerNameDependencies { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }

/** What to show in place of the names stored with work: the names people chose now, and the names that REPLACE a stored copy outright (ERASE-NAME-2: "A former member" for an erased person, the placeholder for a removed one). */
export interface OwnerNameOverlay { chosen: ReadonlyMap<string, string>; replaced: NameReplacements }

/** One BatchGetItem per 100 people (plus the erase ledger's tombstone, where the company is known). Empty when the read fails. */
export async function ownerNameOverlay(deps: OwnerNameDependencies, developerIds: Iterable<string>, orgId?: string): Promise<OwnerNameOverlay> {
  const ids = [...new Set(developerIds)];
  const none: OwnerNameOverlay = { chosen: new Map(), replaced: new NameReplacements() };
  if (ids.length === 0) return none;
  try {
    const items = await readNameItems(deps.documentClient, deps.tableName, ids);
    const chosen = new Map<string, string>();
    for (const [developerId, state] of chosenNameStatesOf(items)) if (!state.erased) chosen.set(developerId, state.name);
    // A removed person's marker holds no name; no sign-in table is known here, so they read as the placeholder.
    const replaced = await replacementNamesFrom({ documentClient: deps.documentClient, tableName: deps.tableName, orgId }, ids, items);
    return { chosen, replaced };
  } catch (error) {
    // The name items could not be read: no chosen name (the stored one stands, cosmetic), but nobody's stored copy is shown as it is, as an erased person's would be (ERASE-NAME-2, the safer default).
    logNameLookupFailure("name_items", error, ids.length);
    return { chosen: new Map(), replaced: new NameReplacements(ids.map((id) => [id, UNAVAILABLE_NAME])) };
  }
}

/** developerId to the name to show, for those among `developerIds` who chose one or need a replacement: the replacement wins. */
export async function chosenOwnerNames(deps: OwnerNameDependencies, developerIds: Iterable<string>, orgId?: string): Promise<Map<string, string>> {
  const overlay = await ownerNameOverlay(deps, developerIds, orgId);
  return new Map([...overlay.chosen, ...overlay.replaced]);
}

/** The owner with the chosen name, when there is one. */
export function withChosenOwnerName<T extends { developerId: string; name: string }>(owner: T, names: ReadonlyMap<string, string>): T {
  const chosen = names.get(owner.developerId);
  return chosen === undefined ? owner : { ...owner, name: chosen };
}

/**
 * `withChosenOwnerName` for a surface that knows when the owner's name was written (the session's or approval's own time), from the overlay `ownerNameOverlay` read: an erased person reads "A former member"
 * unless they came back and the name was written in the new membership, where the name they chose now shows. Without a time (`writtenAt` absent) it is the safe side: "A former member".
 */
export function ownerNamedAt<T extends { developerId: string; name: string }>(owner: T, overlay: OwnerNameOverlay, writtenAt?: string | number): T {
  if (overlay.replaced.has(owner.developerId)) return { ...owner, name: shownNameOf(owner.name, owner.developerId, overlay.replaced, writtenAt) };
  const chosen = overlay.chosen.get(owner.developerId);
  return chosen === undefined ? owner : { ...owner, name: chosen };
}
