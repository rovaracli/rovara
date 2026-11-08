// Live interaction A3 (register LI-2): how long, and in what form, the aliases of an erased person are kept so that an Ask still being answered does not write them. The safer reading is taken: kept no
// longer than the longest-lived Ask record (30 days, `ASK_RETENTION_DAYS`) and then deleted. Controller default; the owner can change it (`ERASED_ALIAS_RETENTION_DAYS`).
//
// What is kept, under `ASKERASED#<org>` with an expiry: the erased person's label tag (`p_xxxxxx`; their developer id is NOT kept) and KEYED HASHES (HMAC-SHA256 under a key the install derives from its own
// signing key) of the names and handles (emails, Slack ids, logins) they were known by. No raw name, email or Slack id is stored. When an answer is written it is scrubbed on the SERVER by hashing its own
// candidate tokens the same way and comparing (`scrubWithAliasHashes`), so a person erased while their name was still in a session's people list, an old note or the model's context cannot come back in a stored
// answer, and a leaked copy of this list says nothing readable. Once the last Ask that could have named them has expired, the entry goes with it.
import { createHmac } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ASK_RETENTION_DAYS, INDEX_EXPIRY_ATTRIBUTE, askErasedAliasKey, askErasedAliasPk, type OrgId } from "@agentx/contracts";
import { FORMER_MEMBER_MENTION, askPersonTag, type AskStoreTable } from "./ask-erase.js";
import { normaliseWords, skeletonOf } from "./ask-names.js";

/** How long an erased person's aliases are kept: as long as the longest-lived Ask (the safer reading of LI-2). */
export const ERASED_ALIAS_RETENTION_DAYS = ASK_RETENTION_DAYS;
const DAY_SECONDS = 86_400;
/** The most aliases of one erased person that are kept (a name list is bounded; more is cut, never refused). */
const ALIASES_MAX = 20;
const ALIAS_MAX_CHARS = 120;
/** The most erased people one read returns (a page; more is cut at the oldest). */
const READ_MAX = 500;
/** The longest run of words a name is looked for in. */
const NAME_WORDS_MAX = 4;

/** The key the alias hashes are made with: derived from the broker's signing key under its own label (an install secret; nothing in code, never logged, never the key itself). */
export const askAliasHashKey = (callbackSigningKey: string): string => createHmac("sha256", callbackSigningKey).update("agentx:ask-alias-hash:v1").digest("hex");

export interface AliasHashes { names: string[]; handles: string[]; mentions: string[] }
export interface ErasedAliasEntry extends AliasHashes { tag: string }

const hash = (key: string, kind: "n" | "h" | "m", value: string): string => createHmac("sha256", key).update(`${kind}\0${value}`, "utf8").digest("hex");
const wordsOf = (skeleton: string): string[] => skeleton.match(/[\p{L}\p{N}]+/gu) ?? [];

/** The hashes of what a person was known by: a multi-word name (the words joined, in either order), each word of a name as an @mention, and each handle. */
export function aliasHashesOf(key: string, person: { names?: readonly string[] | undefined; handles?: readonly string[] | undefined }): AliasHashes {
  const names = new Set<string>(), mentions = new Set<string>(), handles = new Set<string>();
  for (const name of (person.names ?? []).slice(0, ALIASES_MAX)) {
    const words = wordsOf(skeletonOf(normaliseWords(name.slice(0, ALIAS_MAX_CHARS))));
    if (words.length > 1) { names.add(hash(key, "n", words.join(""))); names.add(hash(key, "n", [...words].reverse().join(""))); }
    for (const word of words) if (word.length >= 2) mentions.add(hash(key, "m", word));
  }
  for (const handle of (person.handles ?? []).slice(0, ALIASES_MAX)) {
    const literal = skeletonOf(normaliseWords(handle.slice(0, ALIAS_MAX_CHARS))).trim().replace(/^@/u, "");
    if (literal.length >= 2) handles.add(hash(key, "h", literal));
  }
  return { names: [...names], handles: [...handles], mentions: [...mentions] };
}

/**
 * `text` with every alias of the given erased people replaced by "@former-member", found by hashing the text's own tokens: a handle (an email, a Slack id, a login) is a run of letters, digits and
 * `. _ + - @`; a name is 2 to 4 adjacent words (any spelling, case, accent, look-alike letters, joined or separated, either order); a single word of a name only as an @mention.
 */
export function scrubWithAliasHashes(text: string, entries: readonly ErasedAliasEntry[], key: string): string {
  const normalised = normaliseWords(text);
  if (entries.length === 0) return normalised;
  const skeleton = skeletonOf(normalised);
  const matchable = skeleton.length === normalised.length ? skeleton : normalised.toLowerCase();
  const names = new Set(entries.flatMap((entry) => entry.names)), handles = new Set(entries.flatMap((entry) => entry.handles)), mentions = new Set(entries.flatMap((entry) => entry.mentions));
  const hits: Array<{ start: number; end: number }> = [];
  // Handles: whole runs, with or without a leading @ and a trailing sentence mark.
  for (const run of matchable.matchAll(/@?[\p{L}\p{N}_][\p{L}\p{N}_.+\-@]*/gu)) {
    const trimmed = run[0].replace(/[.+\-@]+$/u, "");
    const literal = trimmed.replace(/^@/u, "");
    if (literal.length >= 2 && handles.has(hash(key, "h", literal))) hits.push({ start: run.index, end: run.index + trimmed.length });
  }
  // Names: windows of adjacent words (only separators between them), and a single word as an @mention.
  const tokens = [...matchable.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({ start: match.index, end: match.index + match[0].length, word: match[0] }));
  for (let first = 0; first < tokens.length; first += 1) {
    const at = tokens[first]!;
    const from = matchable[at.start - 1] === "@" ? at.start - 1 : at.start;
    if (from < at.start && at.word.length >= 2 && mentions.has(hash(key, "m", at.word))) hits.push({ start: from, end: at.end });
    let joined = at.word;
    if (names.has(hash(key, "n", joined))) hits.push({ start: from, end: at.end });
    for (let last = first + 1; last < tokens.length && last < first + NAME_WORDS_MAX; last += 1) {
      const next = tokens[last]!;
      if (!/^[\s,\-_.]{1,3}$/u.test(matchable.slice(tokens[last - 1]!.end, next.start))) break;
      joined += next.word;
      if (names.has(hash(key, "n", joined))) hits.push({ start: from, end: next.end });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "", at = 0;
  for (const hit of hits) {
    if (hit.start < at) continue;
    out += normalised.slice(at, hit.start) + FORMER_MEMBER_MENTION;
    at = hit.end;
  }
  return out + normalised.slice(at);
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);

/**
 * Remembers an erased person's aliases, as hashes, for `ERASED_ALIAS_RETENTION_DAYS`. Idempotent. Without a `key` only the label tag is kept (never a raw alias). The erase runs twice (its second pass
 * carries no names): what is already kept is merged, the first erasure's time stays, and the expiry runs on from this erase.
 */
export async function rememberErasedAliases(
  table: AskStoreTable, orgId: OrgId, person: { developerId: string; names?: readonly string[] | undefined; handles?: readonly string[] | undefined }, nowMs: number, key?: string  ,
): Promise<void> {
  const tag = askPersonTag(person.developerId);
  const itemKey = askErasedAliasKey(orgId, tag);
  const earlierRead = (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: itemKey, ConsistentRead: true }))) as { Item?: Record<string, unknown> };
  // An entry that has expired (the table's TTL may not have removed it yet) is not merged into: its hashes are over, and a new entry starts. A live entry is merged and its expiry runs on from now, so hashes
  // written by a later erase of the same person (who came back and was erased again) are never born expired.
  const earlierExpiry = earlierRead.Item?.[INDEX_EXPIRY_ATTRIBUTE];
  const earlier = typeof earlierExpiry === "number" && earlierExpiry * 1000 > nowMs ? earlierRead : { Item: undefined };
  const fresh = key === undefined ? { names: [], handles: [], mentions: [] } : aliasHashesOf(key, person);
  const merge = (field: keyof AliasHashes, stored: string): string[] => [...new Set([...strings(earlier.Item?.[stored]), ...fresh[field]])];
  await table.documentClient.send(new PutCommand({
    TableName: table.tableName,
    Item: {
      ...itemKey, entityType: "ASK_ERASED_ALIAS", orgId, tag, nameHashes: merge("names", "nameHashes"), handleHashes: merge("handles", "handleHashes"), mentionHashes: merge("mentions", "mentionHashes"),
      erasedAt: typeof earlier.Item?.["erasedAt"] === "string" ? earlier.Item["erasedAt"] : new Date(nowMs).toISOString(),
      [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + ERASED_ALIAS_RETENTION_DAYS * DAY_SECONDS,
    },
  }));
}

/** The erased people whose aliases are still kept (an expired entry is ignored even if the table has not removed it yet). */
export async function readErasedAliases(table: AskStoreTable, orgId: OrgId, nowMs: number): Promise<ErasedAliasEntry[]> {
  const response = await table.documentClient.send(new QueryCommand({
    TableName: table.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": askErasedAliasPk(orgId) }, Limit: READ_MAX, ConsistentRead: true,
  })) as { Items?: Array<Record<string, unknown>> };
  return (response.Items ?? []).flatMap((item) => {
    const expires = item[INDEX_EXPIRY_ATTRIBUTE];
    if (typeof item["tag"] !== "string" || typeof expires !== "number" || expires * 1000 <= nowMs) return [];
    return [{ tag: item["tag"], names: strings(item["nameHashes"]), handles: strings(item["handleHashes"]), mentions: strings(item["mentionHashes"]) }];
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

/**
 * ERASED-REJOIN-NAME: whether `name` is a name the erased person was known by, from the keyed hashes this module keeps (nothing readable is stored or compared). A name of two or more words is the same name when
 * its joined hash, in either word order, is kept (so case, accents, look-alike letters, spacing and word order do not get around it). A one-word name is refused when that word is kept as one of the person's words
 * (the safer side: a person who was "Priya Rao" cannot come back as "Priya"). False when the hashes are not there: no key, the entry expired (it is kept `ERASED_ALIAS_RETENTION_DAYS` days), or the erase kept
 * none (the Team record's switch was off, so no Ask step ran). Throws when the entry cannot be read.
 */
export async function erasedNameIsChosenAgain(table: AskStoreTable, orgId: OrgId, developerId: string, name: string, nowMs: number, key: string | undefined): Promise<boolean> {
  if (key === undefined) return false;
  const response = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: askErasedAliasKey(orgId, askPersonTag(developerId)), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const expires = response.Item?.[INDEX_EXPIRY_ATTRIBUTE];
  if (response.Item === undefined || typeof expires !== "number" || expires * 1000 <= nowMs) return false;
  const kept = { names: new Set(strings(response.Item["nameHashes"])), mentions: new Set(strings(response.Item["mentionHashes"])) };
  const words = wordsOf(skeletonOf(normaliseWords(name.slice(0, ALIAS_MAX_CHARS))));
  if (words.length > 1) return [words.join(""), [...words].reverse().join("")].some((joined) => kept.names.has(hash(key, "n", joined)));
  return words.length === 1 && words[0]!.length >= 2 && kept.mentions.has(hash(key, "m", words[0]!));
}
