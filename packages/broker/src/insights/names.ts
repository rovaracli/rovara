// Insights: the names of people, looked up live for one company and never taken from a stored copy (an erased person reads "A former member", a removed one the placeholder, and a lookup that
// fails reads "Unknown"). Cosmetic: a failed lookup never fails an answer, and logs fixed words only.
import { DeveloperSignInStore } from "../developer/store.js";
import { nameResolverOf, replacementNamesFrom } from "../developer/name-resolver.js";

export interface InsightsNameDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  /** The sign-in table, which holds display names. Without it nobody has a name here. */
  signInTableName?: string | undefined;
}

export const UNKNOWN_PERSON = "Unknown";

/** developerId to the name to show, for every id asked (an id with no readable name reads "Unknown"). */
export async function insightsNames(deps: InsightsNameDependencies, orgId: string, ids: Iterable<string>): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const names = new Map<string, string>(unique.map((id) => [id, UNKNOWN_PERSON]));
  if (unique.length === 0 || deps.signInTableName === undefined) return names;
  try {
    const store = new DeveloperSignInStore({ documentClient: deps.documentClient, tableName: deps.signInTableName, nameTableName: deps.tableName, now: deps.now });
    const { records, nameItems } = await store.getDevelopersWithNameItems(unique);
    const replaced = (await replacementNamesFrom(nameResolverOf({ documentClient: deps.documentClient, tableName: deps.tableName, developer: { signInTableName: deps.signInTableName } }, orgId), unique, nameItems)).currentOnly();
    for (const id of unique) names.set(id, replaced.get(id) ?? records.get(id)?.displayName ?? UNKNOWN_PERSON);
  } catch {
    console.log(JSON.stringify({ component: "broker", event: "insights.names_unavailable", people: unique.length }));
  }
  return names;
}
