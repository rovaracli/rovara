// Release 0.4.18: the name a person chose (PUT /v1/app/me/name) lives in the broker's own State table, as one item per person, not on the sign-in record.
// The broker may read the sign-in table but not write it (a broker bug must not be able to change a revoked or merged mark there), and a sign-in
// never touches this item, so it can never overwrite a chosen name. Readers lay the chosen name over the sign-in record's (`withChosenName`).
import { BatchGetCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { safeDisplayName } from "./person-name.js";

export interface ChosenNameClient { send(command: unknown): Promise<unknown> }
/** The item as stored: `entityType` `DEVELOPER_NAME`, the person's id (also in the key), the name as validated at the route and in the store, and when it was chosen. */
export interface ChosenNameItem { pk: string; sk: string; entityType?: string; developerId?: string; name?: unknown; chosenAt?: string; erased?: unknown; erasedAt?: string; rejoinedAt?: string; eraseRev?: number; removed?: unknown; removedAt?: string }

/**
 * ERASE-NAME-1: what every reader shows for a person who was erased. The erase leaves the same State item behind as a tombstone (`erased: true`, no name), so each reader that already
 * reads the chosen name reads the erased state in the same request, and a stored copy of the name it missed (an event's actor, a task's owner) is still replaced by this.
 */
export const FORMER_MEMBER_NAME = "A former member";
/**
 * One person's state in the name item: the name to show (the chosen one, or `FORMER_MEMBER_NAME` for an erased person) and whether they are erased now.
 * ERASED-REJOIN-NAME: a person who was erased and came back may choose a NEW name for the new membership. The item then holds both: the erasure tombstone (`erased`, `erasedAt`, kept) and the new name
 * (`name`, `chosenAt`). Such a person reads `{ name: <the new name>, erased: false, erasedEver: true, rejoinedAt: <when the new name was chosen> }`: the name to show for the person NOW, while `erasedEver`
 * tells a reader that everything written before `rejoinedAt` belongs to the old membership and stays "A former member". `erasedEver` is true for every person who was ever erased.
 */
export interface ChosenNameState { name: string; erased: boolean; erasedEver?: boolean; rejoinedAt?: string }

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

/** The state an item stands for: an erase tombstone, a name chosen after an erase (a new membership), a usable chosen name, or nothing. */
function stateOf(item: ChosenNameItem | undefined, developerId: string): ChosenNameState | undefined {
  if (item === undefined) return undefined;
  if (item.erased === true) {
    const rejoined = rejoinedOf(item, developerId);
    return rejoined !== undefined ? { name: rejoined.name, erased: false, erasedEver: true, rejoinedAt: rejoined.at } : { name: FORMER_MEMBER_NAME, erased: true, erasedEver: true };
  }
  const name = shownName(item, developerId);
  return name === undefined ? undefined : { name, erased: false };
}

/** The new membership of a person who was erased and came back: the name they chose for it (made safe to show) and when. Only an item that holds both the erasure tombstone and a name chosen after it. */
export function rejoinedOf(item: ChosenNameItem | undefined, developerId: string): { name: string; at: string } | undefined {
  if (item?.erased !== true || typeof item.chosenAt !== "string" || !Number.isFinite(Date.parse(item.chosenAt))) return undefined;
  const name = shownName(item, developerId);
  // `rejoinedAt` is the time of the FIRST name chosen after the erase and survives renames (`chosenAt` moves on every rename); an item without it is read by `chosenAt`.
  const at = typeof item.rejoinedAt === "string" && Number.isFinite(Date.parse(item.rejoinedAt)) ? item.rejoinedAt : item.chosenAt;
  return name === undefined ? undefined : { name, at };
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
 * ERASE-NAME-1, erasure: the name item becomes a tombstone (`erased: true`, no name, no chosen time), so the chosen name is gone from storage and every reader of the item reads "erased". Repeatable: an
 * item that is already a tombstone with no name after it stays as it is (the first `erasedAt` stands, which the time-scoped readers rely on). A person who came back and chose a new name is erased again:
 * the tombstone then carries the new time and the new name is gone too. A name chosen later is allowed only as the name of a new membership (`chosenNameWrite`); the tombstone stays.
 */
export async function eraseChosenName(client: ChosenNameClient, tableName: string, developerId: string, at: string): Promise<void> {
  try {
    await client.send(new PutCommand({
      TableName: tableName,
      Item: { ...chosenNameKey(developerId), entityType: "DEVELOPER_NAME", developerId, erased: true, erasedAt: at },
      ConditionExpression: "attribute_not_exists(pk) OR attribute_not_exists(erased) OR attribute_exists(#name)",
      ExpressionAttributeNames: { "#name": "name" },
    }));
    return;
  } catch (error) {
    if ((error as { name?: string } | undefined)?.name !== "ConditionalCheckFailedException") throw error;
  }
  // A bare tombstone is already there (the first `erasedAt` stands). The erase still counts, so a name choice that read the tombstone before this erase fails: the item's `eraseRev` goes up, and a name write is conditioned on it.
  try {
    await client.send(new UpdateCommand({
      TableName: tableName,
      Key: chosenNameKey(developerId),
      UpdateExpression: "SET eraseRev = if_not_exists(eraseRev, :zero) + :one",
      ConditionExpression: "attribute_exists(erased) AND attribute_not_exists(#name)",
      ExpressionAttributeNames: { "#name": "name" },
      ExpressionAttributeValues: { ":zero": 0, ":one": 1 },
    }));
  } catch (error) {
    // A name was chosen between the two writes: the erase is done again, over the name.
    if ((error as { name?: string } | undefined)?.name !== "ConditionalCheckFailedException") throw error;
    await eraseChosenName(client, tableName, developerId, at);
  }
}

/**
 * ERASED-REJOIN-NAME: the write that makes `name` the person's chosen name, given the item as read just before. A person who was never erased gets the plain item (conditioned on there still being no tombstone).
 * A person who was erased keeps the tombstone (`erased`, `erasedAt`) in the same item and gets the new name beside it; the condition is that the tombstone is still the one that was read (a new erase in between
 * fails the write). The caller has already refused a name that is the erased one (`../agent-sessions/ask-erased-aliases.ts`, `erasedNameIsChosenAgain`).
 */
export function chosenNameWrite(existing: ChosenNameItem | undefined, developerId: string, name: string, at: string): { item: Record<string, unknown>; condition: string; values?: Record<string, unknown> } {
  const base = { ...chosenNameKey(developerId), entityType: "DEVELOPER_NAME", developerId, name, chosenAt: at };
  if (existing?.erased === true && typeof existing.erasedAt === "string") {
    // The first name chosen after the erase sets `rejoinedAt`; a rename keeps it. `eraseRev` counts the erases that landed on a bare tombstone: the write fails when one landed after the item was read.
    const rejoinedAt = typeof existing.rejoinedAt === "string" ? existing.rejoinedAt : at;
    const rev = typeof existing.eraseRev === "number" ? existing.eraseRev : undefined;
    return {
      item: { ...base, erased: true, erasedAt: existing.erasedAt, rejoinedAt, ...(rev === undefined ? {} : { eraseRev: rev }) },
      condition: `erased = :erased AND erasedAt = :erasedAt AND ${rev === undefined ? "attribute_not_exists(eraseRev)" : "eraseRev = :eraseRev"}`,
      values: { ":erased": true, ":erasedAt": existing.erasedAt, ...(rev === undefined ? {} : { ":eraseRev": rev }) },
    };
  }
  return { item: base, condition: "attribute_not_exists(erased)" };
}

/**
 * ERASE-NAME-1, removal: replaces the chosen name of a person removed from the company at `removedAt` with a removal marker (`removed: true`, no name): the name is gone from storage, and a reader that
 * finds the marker (name-resolver.ts) shows the sign-in record's name or the placeholder, never the chosen name, wherever a copy of it was stored. Only a name chosen at or before the removal goes (one chosen
 * after it, by a person who came back, stays), a tombstone is never replaced by the marker (a person who was erased and chose a new name loses that name, the tombstone stays), and a person with no name item gets no marker. Repeatable.
 */
export async function deleteChosenNameOfRemoved(client: ChosenNameClient, tableName: string, developerId: string, removedAt: string): Promise<void> {
  try {
    const found = await client.send(new GetCommand({ TableName: tableName, Key: chosenNameKey(developerId), ConsistentRead: true })) as { Item?: ChosenNameItem };
    const item = found.Item;
    // A person who was erased, came back, chose a new name and is removed again: the new name goes (the tombstone stays, as a tombstone with no name), when it was chosen at or before the removal.
    if (item?.erased === true) {
      if (rejoinedOf(item, developerId) === undefined || typeof item.erasedAt !== "string" || (item.chosenAt ?? "") > removedAt) return;
      await client.send(new PutCommand({
        TableName: tableName,
        Item: { ...chosenNameKey(developerId), entityType: "DEVELOPER_NAME", developerId, erased: true, erasedAt: item.erasedAt },
        ConditionExpression: "erased = :erased AND chosenAt = :chosenAt",
        ExpressionAttributeValues: { ":erased": true, ":chosenAt": item.chosenAt },
      }));
      return;
    }
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
