// Live interaction A3 (register LI-2): how long the names of an erased person are kept so that an Ask still being answered does not write them. The safer reading is taken: the aliases are kept no
// longer than the longest-lived Ask record (30 days, `ASK_RETENTION_DAYS`) and are deleted then. Controller default; the owner can change it (`ERASED_ALIAS_RETENTION_DAYS`).
//
// What is kept: the erased person's label tag (`p_xxxxxx`; their developer id is NOT kept) and the names and handles they were known by (what `ask-names.ts` matches), under `ASKERASED#<org>` with an expiry. An Ask
// is scrubbed against this list on the SERVER when it is written (`AskStoreDependencies.erasedPeople`), so a person erased while their name was still in a session's people list, an old note or
// the model's memory of the context cannot come back in a stored answer. Once the last Ask that could have named them has expired, the list entry goes with it.
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ASK_RETENTION_DAYS, INDEX_EXPIRY_ATTRIBUTE, askErasedAliasKey, askErasedAliasPk, type OrgId } from "@agentx/contracts";
import type { AskStoreTable } from "./ask-erase.js";
import { askPersonTag } from "./ask-erase.js";
import type { NamedPerson } from "./ask-names.js";

/** How long an erased person's aliases are kept: as long as the longest-lived Ask (the safer reading of LI-2). */
export const ERASED_ALIAS_RETENTION_DAYS = ASK_RETENTION_DAYS;
const DAY_SECONDS = 86_400;
/** The most aliases of one erased person that are kept (a name list is bounded; more is cut, never refused). */
const ALIASES_MAX = 20;
const ALIAS_MAX_CHARS = 120;
/** The most erased people one read returns (a page; more is cut at the oldest). */
const READ_MAX = 500;

/** Remembers an erased person's aliases for `ERASED_ALIAS_RETENTION_DAYS`. Idempotent. Never holds anything but ids, names and handles. */
export async function rememberErasedAliases(table: AskStoreTable, orgId: OrgId, person: { developerId: string; names?: readonly string[] | undefined; handles?: readonly string[] | undefined }, nowMs: number): Promise<void> {
  const clip = (values: readonly (string | undefined)[]): string[] => [...new Set(values.map((value) => value?.trim() ?? "").filter((value) => value !== "" && value.length <= ALIAS_MAX_CHARS))].slice(0, ALIASES_MAX);
  const tag = askPersonTag(person.developerId);
  const key = askErasedAliasKey(orgId, tag);
  // The erase runs twice (its second pass carries no names): what is already kept is merged, and the first erasure's time and expiry stay.
  const earlier = (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> };
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
  await table.documentClient.send(new PutCommand({
    TableName: table.tableName,
    Item: {
      ...key, entityType: "ASK_ERASED_ALIAS", orgId, tag, names: clip([...strings(earlier.Item?.["names"]), ...(person.names ?? [])]), handles: clip([...strings(earlier.Item?.["handles"]), ...(person.handles ?? [])]),
      erasedAt: typeof earlier.Item?.["erasedAt"] === "string" ? earlier.Item["erasedAt"] : new Date(nowMs).toISOString(),
      [INDEX_EXPIRY_ATTRIBUTE]: typeof earlier.Item?.[INDEX_EXPIRY_ATTRIBUTE] === "number" ? earlier.Item[INDEX_EXPIRY_ATTRIBUTE] : Math.floor(nowMs / 1000) + ERASED_ALIAS_RETENTION_DAYS * DAY_SECONDS,
    },
  }));
}

/** The erased people whose aliases are still kept (each as `erased:<tag>`: no developer id is kept) (an expired entry is ignored even if the table has not removed it yet). */
export async function readErasedAliases(table: AskStoreTable, orgId: OrgId, nowMs: number): Promise<NamedPerson[]> {
  const response = await table.documentClient.send(new QueryCommand({
    TableName: table.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": askErasedAliasPk(orgId) }, Limit: READ_MAX, ConsistentRead: true,
  })) as { Items?: Array<Record<string, unknown>> };
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
  return (response.Items ?? []).flatMap((item) => {
    const expires = item[INDEX_EXPIRY_ATTRIBUTE];
    if (typeof item["tag"] !== "string" || typeof expires !== "number" || expires * 1000 <= nowMs) return [];
    return [{ developerId: `erased:${item["tag"]}`, tag: item["tag"], names: strings(item["names"]), handles: strings(item["handles"]) }];
  });
}

/** Deletes the entries whose time is over (for environments whose table has no TTL). Bounded to one page; call it with the daily sweep. */
export async function sweepErasedAliases(table: AskStoreTable, orgId: OrgId, nowMs: number): Promise<number> {
  const response = await table.documentClient.send(new QueryCommand({
    TableName: table.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": askErasedAliasPk(orgId) }, Limit: READ_MAX, ConsistentRead: true,
  })) as { Items?: Array<Record<string, unknown>> };
  let deleted = 0;
  for (const item of response.Items ?? []) {
    const expires = item[INDEX_EXPIRY_ATTRIBUTE];
    if (typeof item["sk"] === "string" && typeof expires === "number" && expires * 1000 <= nowMs) {
      await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: { pk: askErasedAliasPk(orgId), sk: item["sk"] } }));
      deleted += 1;
    }
  }
  return deleted;
}
