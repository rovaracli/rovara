// Release 0.4.18: a session stores its owner's name as it was when the session started, which for work begun before a person chose their name is the placeholder.
// What a screen shows is the chosen name now (the State item `DEVELOPER_NAME#<id>`, see developer/chosen-name.ts), read by the stored owner's id, never by the stored name.
// Best effort: a State read that fails shows the stored name, never a failed page. Names go through the email-safe rule in `readChosenNames`.
import { readChosenNameStates, readChosenNames, type ChosenNameState } from "../developer/chosen-name.js";

export interface OwnerNameDependencies { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }

/** developerId to chosen name, for those among `developerIds` who chose one: one BatchGetItem per 100 people. Empty when the read fails. */
export async function chosenOwnerNames(deps: OwnerNameDependencies, developerIds: Iterable<string>): Promise<Map<string, string>> {
  const ids = [...new Set(developerIds)];
  if (ids.length === 0) return new Map();
  try {
    return await readChosenNames(deps.documentClient, deps.tableName, ids);
  } catch {
    return new Map();
  }
}

/** Like `chosenOwnerNames`, with whether each person was erased (ERASE-NAME-1): an erased person reads "A former member", wherever a copy of their name was stored. */
export async function ownerNameStates(deps: OwnerNameDependencies, developerIds: Iterable<string>): Promise<Map<string, ChosenNameState>> {
  const ids = [...new Set(developerIds)];
  if (ids.length === 0) return new Map();
  try {
    return await readChosenNameStates(deps.documentClient, deps.tableName, ids);
  } catch {
    return new Map();
  }
}

/** The owner with the chosen name, when there is one. */
export function withChosenOwnerName<T extends { developerId: string; name: string }>(owner: T, names: ReadonlyMap<string, string>): T {
  const chosen = names.get(owner.developerId);
  return chosen === undefined ? owner : { ...owner, name: chosen };
}
