// Release 0.4.18: a session stores its owner's name as it was when the session started, which for work begun before a person chose their name is the placeholder.
// What a screen shows is the chosen name now (the State item `DEVELOPER_NAME#<id>`, see developer/chosen-name.ts), read by the stored owner's id, never by the stored name.
// Best effort: a State read that fails shows the stored name, never a failed page. Names go through the email-safe rule in `readChosenNames`.
import { readNameItems, chosenNameStatesOf } from "../developer/chosen-name.js";
import { replacementNamesFrom } from "../developer/name-resolver.js";

export interface OwnerNameDependencies { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }

/** What to show in place of the names stored with work: the names people chose now, and the names that REPLACE a stored copy outright (ERASE-NAME-2: "A former member" for an erased person, the placeholder for a removed one). */
export interface OwnerNameOverlay { chosen: ReadonlyMap<string, string>; replaced: ReadonlyMap<string, string> }

/** One BatchGetItem per 100 people (plus the erase ledger's tombstone, where the company is known). Empty when the read fails. */
export async function ownerNameOverlay(deps: OwnerNameDependencies, developerIds: Iterable<string>, orgId?: string): Promise<OwnerNameOverlay> {
  const ids = [...new Set(developerIds)];
  const none: OwnerNameOverlay = { chosen: new Map(), replaced: new Map() };
  if (ids.length === 0) return none;
  try {
    const items = await readNameItems(deps.documentClient, deps.tableName, ids);
    const chosen = new Map<string, string>();
    for (const [developerId, state] of chosenNameStatesOf(items)) if (!state.erased) chosen.set(developerId, state.name);
    // A removed person's marker holds no name; no sign-in table is known here, so they read as the placeholder.
    const replaced = await replacementNamesFrom({ documentClient: deps.documentClient, tableName: deps.tableName, orgId }, ids, items);
    return { chosen, replaced };
  } catch {
    return none;
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
