// Live interaction A5 (fix round 1): everything that REMOVES or MOVES stored Asks: erasing a person, moving a merged duplicate's Asks to the survivor, and the expiry sweep. Kept apart from
// `ask-store.ts` (which writes and reads) and small on purpose: the person-erasure walk in the team record loads this module, so it imports only contracts and the AWS client.
//
// The stored shapes (see ask-store.ts): ASK#<askId> in the session's partition, ASKBY#<developer> (one item per Ask the person asked), ASKMENTION#<tag> (one item per person label the stored text
// names, no cap), ASKEXP#<day> (one item per Ask, by the day it expires).
import { createHash } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  AskRecordSchema, INDEX_EXPIRY_ATTRIBUTE, askByPersonKey, askByPersonPk, askExpiryPk, askLinearScrubKey, askMentionKey, askMentionPk, sessionAskKey,
  type AskRecord, type OrgId, type SessionId,
} from "@agentx/contracts";

export type AskItem = Record<string, unknown>;
export interface AskStoreTable {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
}

/** What a mention of an erased person becomes in other people's stored text. */
export const FORMER_MEMBER_MENTION = "@former-member";

/** The person tag inside a person label (`person p_a1b2c3` is `p_a1b2c3`), the same one the Ask context shows. Same formula as `personLabel` in thread-notes.ts (a test pins them equal). */
export const askPersonTag = (developerId: string): string => `p_${createHash("sha256").update(`person\0${developerId}`, "utf8").digest("hex").slice(0, 6)}`;

const HOUSEKEEPING = new Set(["pk", "sk", "entityType", "orgId", "sessionId", "mentionTags", "linearComment", INDEX_EXPIRY_ATTRIBUTE]);

export const askRecordFromItem = (item: AskItem | undefined): AskRecord | undefined => {
  if (item === undefined) return undefined;
  const parsed = AskRecordSchema.safeParse(Object.fromEntries(Object.entries(item).filter(([key]) => !HOUSEKEEPING.has(key))));
  return parsed.success ? parsed.data : undefined;
};

/** The Linear comment Rovara posted for an Ask (`recordLinearPost` in ask.ts): ids only. Undefined when the Ask was not posted to Linear or the field is not that shape. */
export function linearCommentOfItem(item: AskItem | undefined): { issueKey: string; commentId: string; workspace?: string } | undefined {
  const posted = item?.["linearComment"];
  if (posted === null || typeof posted !== "object") return undefined;
  const { issueKey, commentId, workspace } = posted as Record<string, unknown>;
  if (typeof issueKey !== "string" || typeof commentId !== "string" || issueKey === "" || commentId === "") return undefined;
  return { issueKey, commentId, ...(typeof workspace === "string" && workspace !== "" ? { workspace } : {}) };
}

/** How long a waiting rewrite of a Linear comment is kept before it is dropped (the Ask itself lives 30 days). */
const LINEAR_FIX_TTL_SECONDS = 30 * 86_400;

export const tagsOfItem = (item: AskItem | undefined): string[] =>
  (Array.isArray(item?.["mentionTags"]) ? (item["mentionTags"] as unknown[]) : []).filter((value): value is string => typeof value === "string");

async function queryPartition(table: AskStoreTable, pk: string, limit: number): Promise<AskItem[]> {
  const response = await table.documentClient.send(new QueryCommand({ TableName: table.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk }, Limit: limit, ConsistentRead: true })) as { Items?: AskItem[] };
  return response.Items ?? [];
}

const getItem = async (table: AskStoreTable, key: { pk: string; sk: string }): Promise<AskItem | undefined> =>
  ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true }))) as { Item?: AskItem }).Item;

const del = (table: AskStoreTable, key: { pk: string; sk: string }) => table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: key }));

const isConditional = (error: unknown): boolean => (error as { name?: string }).name === "ConditionalCheckFailedException";

/** The day (`YYYY-MM-DD`, UTC) an Ask whose TTL is `ttlSeconds` expires. */
export const expiryDayOf = (ttlSeconds: number): string => new Date(ttlSeconds * 1000).toISOString().slice(0, 10);

export interface AskEraseBudget { maxItems: number }
export const DEFAULT_ASK_ERASE_BUDGET: AskEraseBudget = { maxItems: 200 };

export interface AskEraseResult {
  /** The Asks the person asked that were deleted. */
  deleted: number;
  /** Other people's Asks whose stored text named the person and now says "@former-member". */
  scrubbed: number;
  /** Nothing is left to do. When false, call again. */
  complete: boolean;
}

/** The record, its mention items, its expiry item and the asker's index item, in the order a crash leaves something the next run still finds (the asker's index item goes last). */
async function deleteAsk(table: AskStoreTable, orgId: OrgId, sessionId: SessionId, askId: string, item: AskItem | undefined, askedBy: string | undefined): Promise<boolean> {
  const record = askRecordFromItem(item);
  let removed = false;
  if (item !== undefined) {
    await del(table, sessionAskKey(orgId, sessionId, askId));
    removed = true;
  }
  for (const tag of tagsOfItem(item)) await del(table, askMentionKey(orgId, tag, sessionId, askId));
  if (record !== undefined) await del(table, { pk: askExpiryPk(orgId, expiryDayOf(record.ttl)), sk: `${sessionId}#${askId}` });
  const by = askedBy ?? record?.askedBy;
  if (by !== undefined) await del(table, askByPersonKey(orgId, by, sessionId, askId));
  return removed;
}

/**
 * A person is erased: every Ask they asked is hard-deleted (record, mention items, expiry item, then their index item), and their label in other people's stored text becomes "@former-member"
 * (and so does anything in `also` that survived into that text: the person's real name, handles, email, Slack and Linear ids, which the writer already replaced by the label, so this is a second line).
 * Mentions go first so the person is named nowhere while the rest runs. Bounded by `budget.maxItems` Asks in each of the two passes; `complete` says whether a further call has work. Idempotent.
 */
export async function eraseAskPerson(table: AskStoreTable, orgId: OrgId, developerId: string, budget: AskEraseBudget = DEFAULT_ASK_ERASE_BUDGET, also: readonly string[] = []): Promise<AskEraseResult> {
  const result: AskEraseResult = { deleted: 0, scrubbed: 0, complete: false };
  const tag = askPersonTag(developerId);
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const extra = [...new Set(also.map((name) => name.trim()).filter((name) => name.length >= 2))].sort((a, b) => b.length - a.length);
  const pattern = new RegExp([`(?:person )?${tag}\\b`, ...extra.map((name) => `(?<![\\p{L}\\p{N}_])${escape(name)}(?![\\p{L}\\p{N}_])`)].join("|"), "giu");

  // 1. Other people's stored text that names the person.
  const mentions = await queryPartition(table, askMentionPk(orgId, tag), budget.maxItems);
  for (const mention of mentions) {
    const sessionId = mention["sessionId"], askId = mention["askId"];
    if (typeof sessionId === "string" && typeof askId === "string" && mention["orgId"] === orgId) {
      const key = sessionAskKey(orgId, sessionId, askId);
      const found = await getItem(table, key);
      const record = askRecordFromItem(found);
      if (record !== undefined) {
        // The record's own list of tags drops the person too: the tag must not outlive the erase anywhere.
        const names: string[] = ["mentionTags = :t"], values: Record<string, unknown> = { ":t": tagsOfItem(found).filter((value) => value !== tag) };
        if (record.question !== undefined) { names.push("question = :q"); values[":q"] = record.question.replace(pattern, FORMER_MEMBER_MENTION); }
        if (record.answer !== undefined) { names.push("answer = :a"); values[":a"] = record.answer.replace(pattern, FORMER_MEMBER_MENTION); }
        await table.documentClient.send(new UpdateCommand({ TableName: table.tableName, Key: key, UpdateExpression: `SET ${names.join(", ")}`, ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: values }))
          .catch((error: unknown) => { if (!isConditional(error)) throw error; });
        // An answer that was posted on a Linear issue still holds the person's name there: the comment waits to be rewritten from the scrubbed record (`ask-linear-scrub.ts`). Ids only.
        const posted = linearCommentOfItem(found);
        if (posted !== undefined) {
          await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...askLinearScrubKey(orgId, sessionId, askId), entityType: "ASK_LINEAR_FIX", orgId, sessionId, askId, ...posted, attempts: 0, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.now() / 1000) + LINEAR_FIX_TTL_SECONDS } }));
        }
        result.scrubbed += 1;
      }
    }
    await del(table, { pk: String(mention["pk"]), sk: String(mention["sk"]) });
  }

  // 2. The person's own Asks.
  const own = await queryPartition(table, askByPersonPk(orgId, developerId), budget.maxItems);
  for (const index of own) {
    const sessionId = index["sessionId"], askId = index["askId"];
    if (typeof sessionId === "string" && typeof askId === "string" && index["orgId"] === orgId) {
      const found = await getItem(table, sessionAskKey(orgId, sessionId, askId));
      if (await deleteAsk(table, orgId, sessionId, askId, found, developerId)) result.deleted += 1;
    }
    await del(table, { pk: String(index["pk"]), sk: String(index["sk"]) });
  }
  result.complete = mentions.length < budget.maxItems && own.length < budget.maxItems;
  return result;
}

/**
 * Two members were merged: the duplicate's Asks become the survivor's (record `askedBy`, the index item), and the duplicate's label in other people's stored text becomes the survivor's, with
 * its mention items, so erasing the survivor later finds every Ask and every mention. Each step is repeatable (the new item is written before the old one goes); bounded, call again until `complete`.
 */
export async function moveAsksOnMerge(table: AskStoreTable, orgId: OrgId, duplicateId: string, survivorId: string, budget: AskEraseBudget = DEFAULT_ASK_ERASE_BUDGET): Promise<{ moved: number; complete: boolean }> {
  let moved = 0;
  const fromTag = askPersonTag(duplicateId), toTag = askPersonTag(survivorId);
  const swap = new RegExp(`\\b${fromTag}\\b`, "gu");
  const asks = await queryPartition(table, askByPersonPk(orgId, duplicateId), budget.maxItems);
  for (const index of asks) {
    const sessionId = index["sessionId"], askId = index["askId"];
    if (typeof sessionId === "string" && typeof askId === "string" && index["orgId"] === orgId) {
      await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...index, ...askByPersonKey(orgId, survivorId, sessionId, askId) } }));
      await table.documentClient.send(new UpdateCommand({ TableName: table.tableName, Key: sessionAskKey(orgId, sessionId, askId), UpdateExpression: "SET askedBy = :to", ConditionExpression: "attribute_exists(pk) AND askedBy = :from", ExpressionAttributeValues: { ":to": survivorId, ":from": duplicateId } }))
        .catch((error: unknown) => { if (!isConditional(error)) throw error; });
      moved += 1;
    }
    await del(table, { pk: String(index["pk"]), sk: String(index["sk"]) });
  }
  const mentions = await queryPartition(table, askMentionPk(orgId, fromTag), budget.maxItems);
  for (const mention of mentions) {
    const sessionId = mention["sessionId"], askId = mention["askId"];
    if (typeof sessionId === "string" && typeof askId === "string" && mention["orgId"] === orgId) {
      const key = sessionAskKey(orgId, sessionId, askId);
      const found = await getItem(table, key);
      const record = askRecordFromItem(found);
      if (record !== undefined) {
        const tags = [...new Set(tagsOfItem(found).map((value) => (value === fromTag ? toTag : value)))];
        const names: string[] = ["mentionTags = :t"], values: Record<string, unknown> = { ":t": tags };
        if (record.question !== undefined) { names.push("question = :q"); values[":q"] = record.question.replace(swap, toTag); }
        if (record.answer !== undefined) { names.push("answer = :a"); values[":a"] = record.answer.replace(swap, toTag); }
        await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...mention, ...askMentionKey(orgId, toTag, sessionId, askId) } }));
        await table.documentClient.send(new UpdateCommand({ TableName: table.tableName, Key: key, UpdateExpression: `SET ${names.join(", ")}`, ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: values }))
          .catch((error: unknown) => { if (!isConditional(error)) throw error; });
      }
    }
    await del(table, { pk: String(mention["pk"]), sk: String(mention["sk"]) });
  }
  return { moved, complete: asks.length < budget.maxItems && mentions.length < budget.maxItems };
}

/** How many days back the sweep looks, so a run that was missed for up to this long still finds what expired meanwhile. */
export const ASK_SWEEP_LOOKBACK_DAYS = 8;

/**
 * Deletes the Asks whose 30 days are over, in every environment (the State table's TTL exists only in named ones): reads the expiry buckets of today and the last
 * `ASK_SWEEP_LOOKBACK_DAYS` days and removes each Ask with its index items. Idempotent and bounded; run it once a day (more often is harmless).
 */
export async function sweepExpiredAsks(table: AskStoreTable, orgId: OrgId, nowMs: number, budget: AskEraseBudget = DEFAULT_ASK_ERASE_BUDGET): Promise<{ deleted: number; complete: boolean }> {
  let deleted = 0, left = budget.maxItems, complete = true;
  for (let back = 0; back <= ASK_SWEEP_LOOKBACK_DAYS; back += 1) {
    if (left <= 0) { complete = false; break; }
    const day = new Date(nowMs - back * 86_400_000).toISOString().slice(0, 10);
    const bucket = await queryPartition(table, askExpiryPk(orgId, day), left);
    for (const entry of bucket) {
      const sessionId = entry["sessionId"], askId = entry["askId"];
      if (typeof sessionId === "string" && typeof askId === "string" && entry["orgId"] === orgId) {
        const found = await getItem(table, sessionAskKey(orgId, sessionId, askId));
        // Only what has really expired: an Ask is never swept before its own TTL (today's bucket also holds Asks that expire later today).
        const record = askRecordFromItem(found);
        if (record !== undefined && record.ttl * 1000 > nowMs) continue;
        if (await deleteAsk(table, orgId, sessionId, askId, found, undefined)) deleted += 1;
      }
      await del(table, { pk: String(entry["pk"]), sk: String(entry["sk"]) });
    }
    if (bucket.length >= left) { complete = false; break; }
    left -= bucket.length;
  }
  return { deleted, complete };
}
