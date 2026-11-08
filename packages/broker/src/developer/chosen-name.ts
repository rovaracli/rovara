// Release 0.4.18: the name a person chose (PUT /v1/app/me/name) lives in the broker's own State table, as one item per person, not on the sign-in record.
// The broker may read the sign-in table but not write it (a broker bug must not be able to change a revoked or merged mark there), and a sign-in
// never touches this item, so it can never overwrite a chosen name. Readers lay the chosen name over the sign-in record's (`withChosenName`).
import { BatchGetCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { safeDisplayName } from "./person-name.js";

export interface ChosenNameClient { send(command: unknown): Promise<unknown> }
/** The item as stored: `entityType` `DEVELOPER_NAME`, the person's id (also in the key), the name as validated at the route and in the store, and when it was chosen. */
export interface ChosenNameItem { pk: string; sk: string; entityType?: string; developerId?: string; name?: unknown; chosenAt?: string; erased?: unknown; erasedAt?: string; removed?: unknown; removedAt?: string }

/**
 * ERASE-NAME-1: what every reader shows for a person who was erased. The erase leaves the same State item behind as a tombstone (`erased: true`, no name), so each reader that already
 * reads the chosen name reads the erased state in the same request, and a stored copy of the name it missed (an event's actor, a task's owner) is still replaced by this.
 */
export const FORMER_MEMBER_NAME = "A former member";
/** One person's state in the name item: the name to show (the chosen one, or `FORMER_MEMBER_NAME` for an erased person) and whether they were erased. */
export interface ChosenNameState { name: string; erased: boolean }

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

/** The state an item stands for: an erase tombstone, a usable chosen name, or nothing. */
function stateOf(item: ChosenNameItem | undefined, developerId: string): ChosenNameState | undefined {
  if (item === undefined) return undefined;
  if (item.erased === true) return { name: FORMER_MEMBER_NAME, erased: true };
  const name = shownName(item, developerId);
  return name === undefined ? undefined : { name, erased: false };
}

/** The person's state from the State table, strongly consistent: their chosen name, "A former member" for an erased person, or undefined when they never chose a name. */
export async function readChosenNameState(client: ChosenNameClient, tableName: string, developerId: string): Promise<ChosenNameState | undefined> {
  const response = await client.send(new GetCommand({ TableName: tableName, Key: chosenNameKey(developerId), ConsistentRead: true })) as { Item?: ChosenNameItem };
  return stateOf(response.Item, developerId);
}

/** The name to show for the person from the State table (their chosen name, or "A former member" once erased), or undefined when they never chose one. */
export async function readChosenName(client: ChosenNameClient, tableName: string, developerId: string): Promise<string | undefined> {
  return (await readChosenNameState(client, tableName, developerId))?.name;
}

/** The chosen name only: undefined for an erased person. For the erase itself, which must not take "A former member" for one of the person's own names. */
export async function readOwnChosenName(client: ChosenNameClient, tableName: string, developerId: string): Promise<string | undefined> {
  const state = await readChosenNameState(client, tableName, developerId);
  return state === undefined || state.erased ? undefined : state.name;
}

/** The raw name items of many people in as few requests as possible (a BatchGetItem per 100, unprocessed keys asked again): developerId to item, for those who have one. */
export async function readNameItems(client: ChosenNameClient, tableName: string, developerIds: readonly string[]): Promise<Map<string, ChosenNameItem>> {
  const items = new Map<string, ChosenNameItem>();
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
        if (developerId !== undefined) items.set(developerId, item);
      }
      keys = response.UnprocessedKeys?.[tableName]?.Keys;
    }
  }
  return items;
}

/** The states the items stand for: developerId to state, for those who chose a name or were erased. */
export function chosenNameStatesOf(items: ReadonlyMap<string, ChosenNameItem>): Map<string, ChosenNameState> {
  const states = new Map<string, ChosenNameState>();
  for (const [developerId, item] of items) {
    const state = stateOf(item, developerId);
    if (state !== undefined) states.set(developerId, state);
  }
  return states;
}

/** The states of many people: developerId to state, for those who chose a name or were erased. */
export async function readChosenNameStates(client: ChosenNameClient, tableName: string, developerIds: readonly string[]): Promise<Map<string, ChosenNameState>> {
  return chosenNameStatesOf(await readNameItems(client, tableName, developerIds));
}

/** The names to show for many people: developerId to name, for those who chose one (an erased person reads "A former member"). */
export async function readChosenNames(client: ChosenNameClient, tableName: string, developerIds: readonly string[]): Promise<Map<string, string>> {
  const states = await readChosenNameStates(client, tableName, developerIds);
  return new Map([...states].map(([developerId, state]) => [developerId, state.name]));
}

/** The sign-in record with the person's chosen name laid over it, marked chosen; the record as it is when there is none. */
export function withChosenName<T extends { displayName: string; displayNameChosen?: boolean }>(record: T, chosen: string | undefined): T {
  return chosen === undefined ? record : { ...record, displayName: chosen, displayNameChosen: true };
}

/**
 * ERASE-NAME-1, erasure: the name item becomes a tombstone (`erased: true`, no name, no chosen time), so the chosen name is gone from storage and every reader of the item reads "erased". Written
 * unconditionally and repeatable. A name chosen later is refused (`setChosenDisplayName` conditions its write on there being no tombstone).
 */
export async function eraseChosenName(client: ChosenNameClient, tableName: string, developerId: string, at: string): Promise<void> {
  await client.send(new PutCommand({ TableName: tableName, Item: { ...chosenNameKey(developerId), entityType: "DEVELOPER_NAME", developerId, erased: true, erasedAt: at } }));
}

/**
 * ERASE-NAME-1, removal: replaces the chosen name of a person removed from the company at `removedAt` with a removal marker (`removed: true`, no name): the name is gone from storage, and a reader that
 * finds the marker (name-resolver.ts) shows the sign-in record's name or the placeholder, never the chosen name, wherever a copy of it was stored. Only a name chosen at or before the removal goes (one chosen
 * after it, by a person who came back, stays), a tombstone is never replaced, and a person with no name item gets no marker. Repeatable.
 */
export async function deleteChosenNameOfRemoved(client: ChosenNameClient, tableName: string, developerId: string, removedAt: string): Promise<void> {
  try {
    await client.send(new PutCommand({
      TableName: tableName,
      Item: { ...chosenNameKey(developerId), entityType: "DEVELOPER_NAME", developerId, removed: true, removedAt },
      ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(erased) AND (attribute_not_exists(chosenAt) OR chosenAt <= :removedAt)",
      ExpressionAttributeValues: { ":removedAt": removedAt },
    }));
  } catch (error) {
    if ((error as { name?: string } | undefined)?.name !== "ConditionalCheckFailedException") throw error;
  }
}
