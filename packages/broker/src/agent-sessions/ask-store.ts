// Live interaction A5: where an "Ask about this task" record lives, how long, and what is written into it.
//
//   ASK#<askId>      in the session's own partition: the asker, the audience, the question, the answer, sizes and the model. It expires 30 days after it was made (owner Q4).
//   ASKBY#<person>   one index item per Ask, so erasing a person finds every Ask they asked. ids only.
//   ASKMENTION#<tag> one index item per person label (`p_` and six hex digits) that the stored text names, with no cap, so erasing a person also finds OTHER people's answers that mention them.
//   ASKEXP#<day>     one item per Ask by the day it expires, so the 30 days are enforced by a sweep in every environment (`sweepExpiredAsks`), not only where the table has a TTL.
//
// What is kept (`askStoresText`): Enterprise keeps the text on every surface; Public keeps it on the web only. A Public Slack or Linear Ask keeps a keyed hash of the question and the sizes, never
// the words (Slack's API terms, CONTEXT 4).
//
// What the stored words never hold: a secret (the question and answer go through `redactText`), a Slack id (mentions become `@member`), an email address, or the real name, handle, email, Slack or
// Linear id of a member the writer knows about (`AskWriteInput.people`): each of those is replaced by that member's label (`person p_xxxxxx`), so the label index is complete and erasure can find
// every place a person is named. A member who is already erased is named as "@former-member" and is never given a label. An Ask asked by an erased person is not stored.
// Removing and moving Asks (erasure, merges, the sweep) is in `ask-erase.ts`.
import { createHmac } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  ASK_RETENTION_DAYS, AskRecordSchema, INDEX_EXPIRY_ATTRIBUTE, askByPersonKey, askExpiryPk, askMentionKey, askStoresText, redactText, sessionAskKey,
  type AskAudience, type AskRecord, type OrgId, type SessionId,
} from "@agentx/contracts";
import { neutralizeSlackMentions } from "./slack-mentions.js";
import { scrubNames, type NamedPerson } from "./ask-names.js";
import { FORMER_MEMBER_MENTION, askPersonTag, askRecordFromItem, eraseAskPerson, expiryDayOf, type AskItem, type AskStoreTable } from "./ask-erase.js";
export { FORMER_MEMBER_MENTION, eraseAskPerson, moveAsksOnMerge, sweepExpiredAsks, askPersonTag, ASK_SWEEP_LOOKBACK_DAYS } from "./ask-erase.js";

type Edition = "enterprise" | "public";

const DAY_SECONDS = 86_400;
/** How long an Ask and its index items live (seconds). */
export const ASK_TTL_SECONDS = ASK_RETENTION_DAYS * DAY_SECONDS;
/** One Ask names at most this many distinct people (a transaction is bounded). More is refused, never silently left out of the index. */
export const ASK_MENTION_TAGS_MAX = 200;
/** The mention items are written this many to a transaction. */
const MENTION_BATCH = 25;
const PERSON_TAG = /\bp_[0-9a-f]{6}\b/gu;
const EMAIL = /[^\s@<>()[\]",;]+@[^\s@<>()[\]",;]+\.[A-Za-z]{2,}/gu;

export interface AskStoreDependencies extends AskStoreTable {
  /**
   * The key the question hash is made with, from a secret the install holds (a reference resolved at start; never in code, never logged). A key shorter than 16 bytes is refused. Without it a short
   * question could be brute-forced from the stored hash.
   */
  questionHashKey: string | Uint8Array;
  /** Whether a person has been erased (the team record's erased marker). Read before and after a write; an answer that cannot be read refuses the write. */
  isErased(developerId: string): Promise<boolean>;
  /**
   * Every erased person of this org that still has to be kept out of new words, with the names and handles they were known by, looked up on the server (never taken from the caller). Each is named
   * "@former-member" wherever they appear, whether or not the caller passed them in `people`. An answer that cannot be read refuses the write. The wiring decides how long and in what form the
   * aliases are kept after an erasure (privacy review): the list may be short-lived, but it must cover the window in which an answer can still be in flight.
   */
  erasedPeople(): Promise<readonly AskPerson[]>;
}

/** A keyed hash of the question: it only recognises the same Ask again, and cannot be looked up in a table of questions without the key. */
export function askQuestionHash(key: string | Uint8Array, askId: string, question: string): string {
  if ((typeof key === "string" ? Buffer.byteLength(key, "utf8") : key.byteLength) < 16) throw new Error("the question hash key is too short");
  return createHmac("sha256", key).update(`ask-question\0${askId}\0${question}`, "utf8").digest("hex");
}

/** A member whose name may appear in the Ask's words: display `names` and specific `handles` (logins, emails, Slack and Linear ids). See `ask-names.ts` for what each is matched as. */
export type AskPerson = NamedPerson;

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
  /** Every member the Ask may name (the session's people and the asker). The writer replaces their names with labels, which is what makes erasure complete. */
  people?: readonly AskPerson[] | undefined;
}

/**
 * The words as they are stored: secrets redacted, Slack mentions and email addresses made neutral, and every known member's names replaced by their label (or by "@former-member" for an erased
 * member), matched after normalising (see `ask-names.ts`).
 */
export function scrubAskText(text: string, people: readonly AskPerson[], erased: ReadonlySet<string>, erasedTags: readonly string[] = []): string {
  let out = scrubNames(neutralizeSlackMentions(redactText(text)), people, (developerId) => (erased.has(developerId) ? FORMER_MEMBER_MENTION : `person ${askPersonTag(developerId)}`));
  // A member who is erased may also appear as the label an earlier turn gave them (an erased person kept only as a tag has no developer id left).
  for (const tag of [...[...erased].map(askPersonTag), ...erasedTags]) out = out.replace(new RegExp(`(?:person )?${tag}\\b`, "gu"), FORMER_MEMBER_MENTION);
  return out.replace(EMAIL, "@member");
}

/** The record as `AskRecordSchema` has it: the words only where the edition and audience keep them. `question` and `answer` are the already-scrubbed words. */
export function askRecordOf(input: AskWriteInput, key: string | Uint8Array, scrubbed: { question: string; answer: string }): AskRecord {
  const keepText = askStoresText(input.edition, input.audience);
  return AskRecordSchema.parse({
    askId: input.askId,
    audience: input.audience,
    ...(input.askedBy === undefined ? {} : { askedBy: input.askedBy }),
    ...(keepText ? { question: scrubbed.question, answer: scrubbed.answer } : {}),
    questionSha256: askQuestionHash(key, input.askId, input.question),
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
  return [...found];
}

const conditionFailed = (error: unknown): boolean => {
  const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
  return reasons?.[0]?.Code === "ConditionalCheckFailed" || (error as { name?: string }).name === "ConditionalCheckFailedException";
};

/**
 * Stores an Ask and answers what happened:
 *  - `erased`: the asker is erased (checked before and again after the write); nothing is kept, and anything the write put down is removed again.
 *  - `exists`: a redelivered request; the first answer stays.
 *  - `written`.
 * The mention items are written first (they are only pointers: a crash leaves harmless items that erasure and expiry remove), then one transaction holds the record (conditional), the asker's index
 * item and the expiry item. After it, every person the text names is checked once more for an erasure that ran meanwhile; if there is one, that person's Asks and mentions are erased now.
 */
export async function writeAsk(deps: AskStoreDependencies, input: AskWriteInput): Promise<"written" | "exists" | "erased"> {
  if (input.askedBy !== undefined && await deps.isErased(input.askedBy)) return "erased";
  const known = await deps.erasedPeople();
  const people = [...(input.people ?? []), ...known.filter((alias) => !(input.people ?? []).some((person) => person.developerId === alias.developerId))];
  const erased = new Set<string>(known.map((alias) => alias.developerId));
  for (const person of people) if (await deps.isErased(person.developerId)) erased.add(person.developerId);
  const erasedTags = known.flatMap((alias) => (alias.tag === undefined ? [] : [alias.tag]));
  const scrubbed = { question: scrubAskText(input.question, people, erased, erasedTags), answer: scrubAskText(input.answer, people, erased, erasedTags) };
  const record = askRecordOf(input, deps.questionHashKey, scrubbed);
  const tags = mentionTagsOf(record);
  if (tags.length > ASK_MENTION_TAGS_MAX) throw new Error("an ask names too many people to index");
  const expiry = { [INDEX_EXPIRY_ATTRIBUTE]: record.ttl };
  const ids = { orgId: input.orgId, sessionId: input.sessionId, askId: input.askId };
  for (let start = 0; start < tags.length; start += MENTION_BATCH) {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: tags.slice(start, start + MENTION_BATCH).map((tag) => (
      { Put: { TableName: deps.tableName, Item: { ...askMentionKey(input.orgId, tag, input.sessionId, input.askId), entityType: "ASK_MENTION", ...ids, ...expiry } } })) }));
  }
  const items: Array<Record<string, unknown>> = [
    { Put: { TableName: deps.tableName, Item: { ...sessionAskKey(input.orgId, input.sessionId, input.askId), entityType: "ASK", orgId: input.orgId, sessionId: input.sessionId, ...record, mentionTags: tags, ...expiry }, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: { TableName: deps.tableName, Item: { pk: askExpiryPk(input.orgId, expiryDayOf(record.ttl)), sk: `${input.sessionId}#${input.askId}`, entityType: "ASK_EXPIRY", ...ids, ...expiry } } },
    ...(input.askedBy === undefined ? [] : [{ Put: { TableName: deps.tableName, Item: { ...askByPersonKey(input.orgId, input.askedBy, input.sessionId, input.askId), entityType: "ASK_BY_PERSON", ...ids, ...expiry } } }]),
  ];
  let outcome: "written" | "exists" = "written";
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    // A transaction cancelled by a condition names the ASK item's check; anything else is a real fault and is thrown (nothing was stored).
    if (!conditionFailed(error)) throw error;
    outcome = "exists";
  }
  // An erasure that ran while this answer was being made: the person's marker is in, so what was just written is taken out again.
  const late = new Set<string>();
  if (input.askedBy !== undefined && await deps.isErased(input.askedBy)) late.add(input.askedBy);
  for (const person of people) if (!erased.has(person.developerId) && tags.includes(askPersonTag(person.developerId)) && await deps.isErased(person.developerId)) late.add(person.developerId);
  for (const developerId of late) await eraseAskPerson(deps, input.orgId, developerId);
  return input.askedBy !== undefined && late.has(input.askedBy) ? "erased" : outcome;
}

/**
 * A web Ask as its asker reads it. Only the person who asked sees a web answer: anyone else (the owner, a teammate, an admin) gets nothing, and so does a record that has expired but is
 * not yet removed. An Ask from another audience is shown where it was asked (the Slack thread, the Linear issue), never through here.
 */
export async function readAskAsAsker(deps: AskStoreTable, orgId: OrgId, sessionId: SessionId, askId: string, viewerDeveloperId: string, nowMs: number): Promise<AskRecord | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: sessionAskKey(orgId, sessionId, askId), ConsistentRead: true })) as { Item?: AskItem };
  const record = askRecordFromItem(response.Item);
  if (record === undefined || response.Item?.["orgId"] !== orgId || record.audience !== "web" || record.askedBy !== viewerDeveloperId || record.ttl * 1000 <= nowMs) return undefined;
  return record;
}
