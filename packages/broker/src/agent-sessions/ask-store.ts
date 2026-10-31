// Live interaction A5: where an "Ask about this task" record lives, how long, and how it is erased.
//
//   ASK#<askId>      in the session's own partition: the asker, the audience, the question, the answer, sizes and the model. It expires 30 days after it was made (owner Q4).
//   ASKBY#<person>   one index item per Ask, so erasing a person finds every Ask they asked. ids only.
//   ASKMENTION#<tag> one index item per person label (`p_` and six hex digits) that the stored text names, so erasing a person also finds OTHER people's answers that mention them.
//
// What is kept (`askStoresText`): Enterprise keeps the text on every surface; Public keeps it on the web only. A Public Slack or Linear Ask keeps a salted hash of the question and the sizes, never
// the words (Slack's API terms, CONTEXT 4). Slack mentions (`<@U…>`) are replaced by the neutral word before anything is stored, so no Slack id is ever kept.
//
// Erasure (`eraseAskPerson`): every Ask the person asked is hard-deleted (the record first, then its mention items, then the person's own index item last, so a crash leaves an item the next run
// finds); the person's label in everyone else's stored answers becomes "@former-member". Bounded and resumable: it does what its budget allows and says whether it finished.
// The visible rule: a web answer is read only by the person who asked it (`readAskAsAsker`).
import { createHash } from "node:crypto";
import { DeleteCommand, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  ASK_RETENTION_DAYS, AskRecordSchema, INDEX_EXPIRY_ATTRIBUTE, askByPersonKey, askByPersonPk, askMentionKey, askMentionPk, askStoresText, sessionAskKey,
  type AskAudience, type AskRecord, type OrgId, type SessionId,
} from "@agentx/contracts";
import { neutralizeSlackMentions } from "./ask-context.js";
import { personLabel } from "../aws/developer-tasks/thread-notes.js";

type Edition = "enterprise" | "public";
type Item = Record<string, unknown>;

const DAY_SECONDS = 86_400;
/** How long an Ask and its index items live (seconds). */
export const ASK_TTL_SECONDS = ASK_RETENTION_DAYS * DAY_SECONDS;
/** What a mention of an erased person becomes in other people's stored answers. */
export const FORMER_MEMBER_MENTION = "@former-member";
/** At most this many person labels are indexed for one Ask (the transaction stays well under DynamoDB's 100 items). */
const MENTION_LABELS_MAX = 10;
const PERSON_TAG = /\bp_[0-9a-f]{6}\b/gu;

export interface AskStoreDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
}

/** The person tag inside a person label: `person p_a1b2c3` is `p_a1b2c3`. */
const tagOf = (developerId: string): string => personLabel(developerId).slice("person ".length);

/** A hash of the question that cannot be matched against a dictionary of questions: it is salted with the Ask's own id. It only recognises the same Ask again. */
export function askQuestionHash(askId: string, question: string): string {
  return createHash("sha256").update(`ask-question\0${askId}\0${question}`, "utf8").digest("hex");
}

export interface AskWriteInput {
  edition: Edition;
  orgId: OrgId;
  sessionId: SessionId;
  askId: string;
  audience: AskAudience;
  /** The asker's developer id, when the asker is a member. An outsider (a Slack user who is not a member) has none and no erasure index. */
  askedBy?: string | undefined;
  question: string;
  answer: string;
  contextBytes: number;
  model: string;
  nowMs: number;
}

/** The record as `AskRecordSchema` has it: the words only where the edition and audience keep them. */
export function askRecordOf(input: AskWriteInput): AskRecord {
  const keepText = askStoresText(input.edition, input.audience);
  const question = neutralizeSlackMentions(input.question);
  const answer = neutralizeSlackMentions(input.answer);
  return AskRecordSchema.parse({
    askId: input.askId,
    audience: input.audience,
    ...(input.askedBy === undefined ? {} : { askedBy: input.askedBy }),
    ...(keepText ? { question, answer } : {}),
    questionSha256: askQuestionHash(input.askId, input.question),
    contextBytes: input.contextBytes,
    answerBytes: Buffer.byteLength(input.answer, "utf8"),
    model: input.model,
    createdAt: new Date(input.nowMs).toISOString(),
    ttl: Math.floor(input.nowMs / 1000) + ASK_TTL_SECONDS,
  });
}

/** The person tags a record's stored text names (none when no text is stored). */
function mentionTagsOf(record: AskRecord): string[] {
  const found = new Set<string>();
  for (const text of [record.question, record.answer]) for (const match of text?.matchAll(PERSON_TAG) ?? []) found.add(match[0]);
  return [...found].slice(0, MENTION_LABELS_MAX);
}

/**
 * Stores an Ask: the record (conditional on it not existing, so a redelivered request leaves the first answer), the asker's index item, and one mention item per person label the stored text
 * names. One transaction. Answers `exists` when the Ask was already stored.
 */
export async function writeAsk(deps: AskStoreDependencies, input: AskWriteInput): Promise<"written" | "exists"> {
  const record = askRecordOf(input);
  const tags = mentionTagsOf(record);
  const expiry = { [INDEX_EXPIRY_ATTRIBUTE]: record.ttl };
  const ids = { orgId: input.orgId, sessionId: input.sessionId, askId: input.askId };
  const items: Array<Record<string, unknown>> = [
    { Put: { TableName: deps.tableName, Item: { ...sessionAskKey(input.orgId, input.sessionId, input.askId), entityType: "ASK", orgId: input.orgId, sessionId: input.sessionId, ...record, mentionTags: tags, ...expiry }, ConditionExpression: "attribute_not_exists(pk)" } },
    ...(input.askedBy === undefined ? [] : [{ Put: { TableName: deps.tableName, Item: { ...askByPersonKey(input.orgId, input.askedBy, input.sessionId, input.askId), entityType: "ASK_BY_PERSON", ...ids, ...expiry } } }]),
    ...tags.map((tag) => ({ Put: { TableName: deps.tableName, Item: { ...askMentionKey(input.orgId, tag, input.sessionId, input.askId), entityType: "ASK_MENTION", ...ids, ...expiry } } })),
  ];
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    return "written";
  } catch (error) {
    // A transaction cancelled by a condition names the ASK item's check; anything else is a real fault and is thrown (nothing was stored).
    const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
    if (reasons?.[0]?.Code === "ConditionalCheckFailed" || (error as { name?: string }).name === "ConditionalCheckFailedException") return "exists";
    throw error;
  }
}

const HOUSEKEEPING = new Set(["pk", "sk", "entityType", "orgId", "sessionId", "mentionTags", INDEX_EXPIRY_ATTRIBUTE]);

const recordOf = (item: Item | undefined): AskRecord | undefined => {
  if (item === undefined) return undefined;
  const parsed = AskRecordSchema.safeParse(Object.fromEntries(Object.entries(item).filter(([key]) => !HOUSEKEEPING.has(key))));
  return parsed.success ? parsed.data : undefined;
};

/**
 * A web Ask as its asker reads it. Only the person who asked sees a web answer: anyone else (the owner, a teammate, an admin) gets nothing, and so does a record that has expired but is
 * not yet removed by the table's TTL. An Ask from another audience is shown where it was asked (the Slack thread, the Linear issue), never through here.
 */
export async function readAskAsAsker(deps: AskStoreDependencies, orgId: OrgId, sessionId: SessionId, askId: string, viewerDeveloperId: string, nowMs: number): Promise<AskRecord | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: sessionAskKey(orgId, sessionId, askId), ConsistentRead: true })) as { Item?: Item };
  const record = recordOf(response.Item);
  if (record === undefined || response.Item?.["orgId"] !== orgId || record.audience !== "web" || record.askedBy !== viewerDeveloperId || record.ttl * 1000 <= nowMs) return undefined;
  return record;
}

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

async function queryPartition(deps: AskStoreDependencies, pk: string, limit: number): Promise<Item[]> {
  const response = await deps.documentClient.send(new QueryCommand({ TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk }, Limit: limit, ConsistentRead: true })) as { Items?: Item[] };
  return response.Items ?? [];
}

const del = (deps: AskStoreDependencies, key: { pk: string; sk: string }) => deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: key }));

/**
 * A person is erased: every Ask they asked is hard-deleted (record, mention items, then their index item), and their label in other people's stored text becomes "@former-member".
 * Mentions go first so the person is named nowhere while the rest runs. Bounded by `budget.maxItems` Asks in each of the two passes; `complete` says whether a further call has work.
 * Idempotent: a repeat finds nothing and answers complete.
 */
export async function eraseAskPerson(deps: AskStoreDependencies, orgId: OrgId, developerId: string, budget: AskEraseBudget = DEFAULT_ASK_ERASE_BUDGET): Promise<AskEraseResult> {
  const result: AskEraseResult = { deleted: 0, scrubbed: 0, complete: false };
  const tag = tagOf(developerId);
  const tagPattern = new RegExp(`(?:person )?${tag}\\b`, "gu");

  // 1. Other people's stored text that names the person.
  const mentions = await queryPartition(deps, askMentionPk(orgId, tag), budget.maxItems);
  for (const mention of mentions) {
    const sessionId = mention["sessionId"], askId = mention["askId"];
    if (typeof sessionId === "string" && typeof askId === "string" && mention["orgId"] === orgId) {
      const key = sessionAskKey(orgId, sessionId, askId);
      const found = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Item };
      const record = recordOf(found.Item);
      if (record !== undefined) {
        const question = record.question?.replace(tagPattern, FORMER_MEMBER_MENTION);
        const answer = record.answer?.replace(tagPattern, FORMER_MEMBER_MENTION);
        // The record's own list of tags drops the person too: the tag must not outlive the erase anywhere.
        const kept = (Array.isArray(found.Item?.["mentionTags"]) ? (found.Item["mentionTags"] as unknown[]) : []).filter((value) => typeof value === "string" && value !== tag);
        const names: string[] = ["mentionTags = :t"], values: Record<string, unknown> = { ":t": kept };
        if (question !== undefined) { names.push("question = :q"); values[":q"] = question; }
        if (answer !== undefined) { names.push("answer = :a"); values[":a"] = answer; }
        await deps.documentClient.send(new UpdateCommand({ TableName: deps.tableName, Key: key, UpdateExpression: `SET ${names.join(", ")}`, ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: values }))
          .catch((error: unknown) => { if ((error as { name?: string }).name !== "ConditionalCheckFailedException") throw error; });
        result.scrubbed += 1;
      }
    }
    await del(deps, { pk: String(mention["pk"]), sk: String(mention["sk"]) });
  }

  // 2. The person's own Asks: the record, then its mention items, then the person's index item.
  const own = await queryPartition(deps, askByPersonPk(orgId, developerId), budget.maxItems);
  for (const index of own) {
    const sessionId = index["sessionId"], askId = index["askId"];
    if (typeof sessionId === "string" && typeof askId === "string" && index["orgId"] === orgId) {
      const key = sessionAskKey(orgId, sessionId, askId);
      const found = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Item };
      const tags = Array.isArray(found.Item?.["mentionTags"]) ? (found.Item["mentionTags"] as unknown[]).filter((value): value is string => typeof value === "string") : [];
      if (found.Item !== undefined) {
        await del(deps, key);
        result.deleted += 1;
      }
      for (const mentioned of tags) await del(deps, askMentionKey(orgId, mentioned, sessionId, askId));
    }
    await del(deps, { pk: String(index["pk"]), sk: String(index["sk"]) });
  }
  result.complete = mentions.length < budget.maxItems && own.length < budget.maxItems;
  return result;
}
