// Release 0.4.18: the name a person chose (PUT /v1/app/me/name) lives in the broker's own State table, as one item per person, not on the sign-in record.
// The broker may read the sign-in table but not write it (a broker bug must not be able to change a revoked or merged mark there), and a sign-in
// never touches this item, so it can never overwrite a chosen name. Readers lay the chosen name over the sign-in record's (`withChosenName`).
import { BatchGetCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { safeDisplayName } from "./person-name.js";

export interface ChosenNameClient { send(command: unknown): Promise<unknown> }
/** The item as stored: `entityType` `DEVELOPER_NAME`, the person's id (also in the key), the name as validated at the route and in the store, and when it was chosen. */
export interface ChosenNameItem { pk: string; sk: string; entityType?: string; developerId?: string; name?: unknown; chosenAt?: string }

const CHOSEN_NAME_SORT_KEY = "NAME";
/** BatchGetItem takes 100 keys at most. */
const BATCH_GET_KEYS = 100;

/** `DEVELOPER_NAME#<developerId>` / `NAME`, beside `DEVELOPER_ORG#<developerId>` / `ORG` in the State table. */
export function chosenNameKey(developerId: string): { pk: string; sk: string } {
  return { pk: `DEVELOPER_NAME#${developerId}`, sk: CHOSEN_NAME_SORT_KEY };
}

/** The stored name made safe to show, or undefined when the item holds no usable name (such an item is ignored, and the sign-in record's name shows). */
function shownName(item: ChosenNameItem | undefined, developerId: string): string | undefined {
  if (item === undefined || typeof item.name !== "string" || item.name.trim() === "") return undefined;
  return safeDisplayName(item.name, developerId);
}

/** The person's chosen name from the State table, strongly consistent, or undefined when they never chose one. */
export async function readChosenName(client: ChosenNameClient, tableName: string, developerId: string): Promise<string | undefined> {
  const response = await client.send(new GetCommand({ TableName: tableName, Key: chosenNameKey(developerId), ConsistentRead: true })) as { Item?: ChosenNameItem };
  return shownName(response.Item, developerId);
}

/** The chosen names of many people in as few requests as possible (a BatchGetItem per 100, unprocessed keys asked again): developerId to name, for those who chose one. */
export async function readChosenNames(client: ChosenNameClient, tableName: string, developerIds: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const unique = [...new Set(developerIds)];
  for (let start = 0; start < unique.length; start += BATCH_GET_KEYS) {
    let keys: Array<{ pk: string; sk: string }> | undefined = unique.slice(start, start + BATCH_GET_KEYS).map(chosenNameKey);
    // DynamoDB may hand back some keys unprocessed; they are asked for again, a few times at most, and a name that stays unread falls back to the sign-in record's.
    for (let attempt = 0; keys !== undefined && keys.length > 0 && attempt < 4; attempt += 1) {
      const response = await client.send(new BatchGetCommand({ RequestItems: { [tableName]: { Keys: keys, ConsistentRead: true } } })) as {
        Responses?: Record<string, ChosenNameItem[] | undefined>; UnprocessedKeys?: Record<string, { Keys?: Array<{ pk: string; sk: string }> } | undefined>;
      };
      for (const item of response.Responses?.[tableName] ?? []) {
        const developerId = item.pk.startsWith("DEVELOPER_NAME#") ? item.pk.slice("DEVELOPER_NAME#".length) : undefined;
        const name = developerId === undefined ? undefined : shownName(item, developerId);
        if (developerId !== undefined && name !== undefined) names.set(developerId, name);
      }
      keys = response.UnprocessedKeys?.[tableName]?.Keys;
    }
  }
  return names;
}

/** The sign-in record with the person's chosen name laid over it, marked chosen; the record as it is when there is none. */
export function withChosenName<T extends { displayName: string; displayNameChosen?: boolean }>(record: T, chosen: string | undefined): T {
  return chosen === undefined ? record : { ...record, displayName: chosen, displayNameChosen: true };
}
