// Second review (lane cr-settings, switch `cr`): the notice to company admins when the model that reviews stops qualifying (owner decision 2026-11-02: "Changes are never silent: if the chosen or default reviewer stops
// qualifying, the admin is told"). One notice per CHANGE:
//   - A problem is derived from the plan a review start made (`problemOf`): the company's choice no longer qualifies (all of it, or a model of it), the default moved on, or nothing qualifies at all. Its `key` is a hash of
//     the code word and the models with their reasons, so the same situation has the same key.
//     A skip that only says THIS task's builder is from the same AI company as the model (`same-company`) is about the task, not the company's choice, and is never a problem (a start that has only those is
//     neutral: it neither raises, resets nor counts toward closing).
//   - `noteQualification` keeps ONE current row per company (`SECONDREVIEW#NOTICE`): a new key writes a new open notice (conditionally, so two review starts racing write it once), the same key writes nothing.
//     The notice CLOSES only once the reviewer has qualified for 24 hours or 3 starts in a row (a problem seen again in between starts the count over), so a model that flaps does not close and reopen it at every start.
//     The last key an admin marked seen is remembered: the same problem coming back within a week is written already seen (no new card), a different one is told at once.
//   - The notice is shown as a decision card to the company's owners and admins (`secondReviewNoticeItemsFor`, in the existing cards list) and as a banner on the settings page. An admin's "I've seen it" puts the card
//     away; it does not close the problem. Fixed words only: the notice holds model names and reason words, never a model's output.
import { createHash } from "node:crypto";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { orgMetaKey, secondReviewModelKey, type SecondReviewModelRef } from "@agentx/contracts";
import type { SettingsTable } from "../org/second-review-settings.js";
import type { DecisionItem } from "../decisions/project.js";
import type { SecondReviewPlan, SecondReviewSkipped, SecondReviewSkippedWhy } from "./second-review.js";

export const SECOND_REVIEW_NOTICE_SK = "SECONDREVIEW#NOTICE";
export const NOTICE_CODES = ["choice-not-qualifying", "model-dropped", "default-changed", "no-candidate"] as const;
export type NoticeCode = (typeof NOTICE_CODES)[number];
export interface QualificationProblem { code: NoticeCode; key: string; models: Array<{ model: SecondReviewModelRef; why?: SecondReviewSkippedWhy }> }

/** The words each code says to an admin. Fixed text. */
export const NOTICE_TEXT: Record<NoticeCode, string> = {
  "choice-not-qualifying": "The second-opinion model your company chose no longer qualifies, so tasks show \"Second review did not run\" until you choose another or it qualifies again.",
  "model-dropped": "One of the second-opinion models your company chose no longer qualifies and is being skipped.",
  "default-changed": "The default second-opinion model changed because the earlier one no longer fits.",
  "no-candidate": "No allowed model from a different AI company can be used for the second opinion, so it is not running.",
};
const WHY_TEXT: Record<SecondReviewSkippedWhy, string> = { "not-routable": "no connected source serves it", "not-allowed": "it is not allowed here", "same-company": "it is from the same AI company as the model that wrote the code", "company-unknown": "its maker is not known" };
export const noticeWhyText = (why: SecondReviewSkippedWhy): string => WHY_TEXT[why];

const keyOf = (code: NoticeCode, models: ReadonlyArray<{ model: SecondReviewModelRef; why?: string | undefined }>): string =>
  createHash("sha256").update(`${code}\n${models.map((entry) => `${secondReviewModelKey(entry.model)}=${entry.why ?? ""}`).sort().join("\n")}`, "utf8").digest("hex").slice(0, 32);

/** A skip because of THIS task's builder: the same AI company as the model that wrote the code. It says nothing about whether the company's choice qualifies. */
const taskSpecific = (entry: { why: SecondReviewSkippedWhy }): boolean => entry.why === "same-company";

/**
 * The problem a plan shows, or none when the reviewer qualifies (`mode` off: nothing is expected to run, so nothing is wrong). Skips that only concern this task's builder (`same-company`) are left out: when nothing
 * else remains there is no company-wide problem to tell an admin about.
 */
export function problemOf(plan: SecondReviewPlan): QualificationProblem | undefined {
  const make = (code: NoticeCode, models: QualificationProblem["models"]): QualificationProblem => ({ code, key: keyOf(code, models), models });
  const general = (skipped: readonly SecondReviewSkipped[]) => skipped.filter((entry) => !taskSpecific(entry));
  if (!plan.run) {
    const skipped = plan.skipped ?? [];
    if (plan.reason === "choice-not-qualifying") {
      const left = general(skipped);
      // Every model of the choice was left out only because of this task's builder: the choice is fine.
      if (skipped.length > 0 && left.length === 0) return undefined;
      return make("choice-not-qualifying", left.map((entry) => ({ model: entry.model, why: entry.why })));
    }
    if (plan.reason === "no-candidate") return skipped.length > 0 && general(skipped).length === 0 ? undefined : make("no-candidate", []);
    return undefined;
  }
  if (plan.choice === "company" && general(plan.skipped).length > 0) return make("model-dropped", general(plan.skipped).map((entry) => ({ model: entry.model, why: entry.why })));
  if (plan.choice === "default" && plan.defaultChanged === true) return make("default-changed", [{ model: { provider: plan.model.provider, modelId: plan.model.modelId } }]);
  return undefined;
}

/**
 * What a review start tells the notice: the company-wide problem it found, `undefined` when the reviewer plainly qualifies (it ran, with nothing of the company's choice left out), or `"neutral"` when the start
 * says nothing either way (the mode is off, no builder model is known, or the only skips are about this task's builder).
 */
export function observationOf(plan: SecondReviewPlan): QualificationProblem | undefined | "neutral" {
  const problem = problemOf(plan);
  if (problem !== undefined) return problem;
  return plan.run && plan.skipped.length === 0 ? undefined : "neutral";
}

/** The notice closes after this many starts in a row in which the reviewer qualified, or after this long since the first of them, whichever comes first. */
export const NOTICE_CLOSE_AFTER_STARTS = 3;
export const NOTICE_CLOSE_AFTER_MS = 24 * 3_600_000;
/** While a notice stays open, a problem that comes back with the key an admin last marked seen is written already seen if that was within this long. */
export const NOTICE_RESEEN_QUIET_MS = 7 * 86_400_000;

export interface StoredNotice { key: string; code: NoticeCode; models: QualificationProblem["models"]; createdAt: string; status: "open" | "seen"; seenAt?: string }
const orgPk = (orgId: string): string => orgMetaKey(orgId).pk;
const keyFor = (orgId: string) => ({ pk: orgPk(orgId), sk: SECOND_REVIEW_NOTICE_SK });
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

function parseNotice(item: Record<string, unknown> | undefined): StoredNotice | undefined {
  if (item === undefined || item.status === "closed") return undefined;
  const code = NOTICE_CODES.find((entry) => entry === item.code);
  if (code === undefined || typeof item.key !== "string" || typeof item.createdAt !== "string" || (item.status !== "open" && item.status !== "seen") || !Array.isArray(item.models)) return undefined;
  return { key: item.key, code, models: item.models as QualificationProblem["models"], createdAt: item.createdAt, status: item.status, ...(typeof item.seenAt === "string" ? { seenAt: item.seenAt } : {}) };
}

export async function readNotice(table: SettingsTable, orgId: string): Promise<StoredNotice | undefined> {
  return parseNotice((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: keyFor(orgId), ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item);
}

/**
 * Records what a review start found. A new problem (a key that is not the current one) writes an open notice, once; the same problem writes nothing (and starts the closing count over); a start where the reviewer
 * qualifies counts toward closing the notice (3 in a row or 24 hours), and a neutral start changes nothing. Best effort: it never throws (a notice that cannot be written is logged by error name, and the review goes on).
 */
export async function noteQualification(table: SettingsTable, orgId: string, observation: QualificationProblem | undefined | "neutral", at: number): Promise<"written" | "same" | "closed" | "recovering" | "none" | "failed"> {
  try {
    if (observation === "neutral") return "none";
    const problem = observation;
    const current = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: keyFor(orgId), ConsistentRead: true })) as { Item?: Record<string, unknown> };
    const item = current.Item;
    if (problem === undefined) {
      if (item === undefined || item.status === "closed") return "none";
      const starts = (typeof item.okStarts === "number" ? item.okStarts : 0) + 1;
      const since = typeof item.okSince === "string" && !Number.isNaN(Date.parse(item.okSince)) ? item.okSince : new Date(at).toISOString();
      const enough = starts >= NOTICE_CLOSE_AFTER_STARTS || at - Date.parse(since) >= NOTICE_CLOSE_AFTER_MS;
      const names = { "#s": "status", "#k": "key" };
      const guard = { ConditionExpression: "#k = :key AND #s <> :closed", ExpressionAttributeNames: enough ? { ...names, "#ls": "lastSeenKey", "#la": "lastSeenAt" } : { ...names, "#o": "okStarts", "#os": "okSince" } };
      await table.documentClient.send(new UpdateCommand({
        TableName: table.tableName, Key: keyFor(orgId), ...guard,
        // Closing forgets what was seen: the memory of a seen key belongs to a notice that stays open, so a problem that comes back after a close is a new card.
        UpdateExpression: enough ? "SET #s = :closed REMOVE #ls, #la" : "SET #o = :starts, #os = :since",
        ExpressionAttributeValues: enough ? { ":closed": "closed", ":key": item.key } : { ":closed": "closed", ":key": item.key, ":starts": starts, ":since": since },
      })).catch((error: unknown) => { if (errorName(error) !== "ConditionalCheckFailedException") throw error; });
      return enough ? "closed" : "recovering";
    }
    if (item !== undefined && item.status !== "closed" && item.key === problem.key) {
      // The problem is still there: whatever count toward closing was started is over.
      if (item.okStarts !== undefined || item.okSince !== undefined) {
        await table.documentClient.send(new UpdateCommand({ TableName: table.tableName, Key: keyFor(orgId), UpdateExpression: "REMOVE #o, #os", ConditionExpression: "#k = :key", ExpressionAttributeNames: { "#o": "okStarts", "#os": "okSince", "#k": "key" }, ExpressionAttributeValues: { ":key": problem.key } }))
          .catch((error: unknown) => { if (errorName(error) !== "ConditionalCheckFailedException") throw error; });
      }
      return "same";
    }
    // A key that is not the current one, or a closed row: write it, unless another start just wrote this very key. The last key an admin marked seen is carried along; the same problem within the quiet time is written seen.
    const lastSeenKey = typeof item?.lastSeenKey === "string" ? item.lastSeenKey : undefined;
    const lastSeenAt = typeof item?.lastSeenAt === "string" ? item.lastSeenAt : undefined;
    const quiet = lastSeenKey === problem.key && lastSeenAt !== undefined && at - Date.parse(lastSeenAt) < NOTICE_RESEEN_QUIET_MS;
    await table.documentClient.send(new PutCommand({
      TableName: table.tableName,
      Item: { ...keyFor(orgId), entityType: "SECOND_REVIEW_NOTICE", key: problem.key, code: problem.code, models: problem.models, createdAt: new Date(at).toISOString(), status: quiet ? "seen" : "open",
        ...(quiet ? { seenAt: lastSeenAt } : {}), ...(lastSeenKey === undefined || lastSeenAt === undefined ? {} : { lastSeenKey, lastSeenAt }) },
      ConditionExpression: "attribute_not_exists(pk) OR #s = :closed OR #k <> :key", ExpressionAttributeNames: { "#s": "status", "#k": "key" }, ExpressionAttributeValues: { ":closed": "closed", ":key": problem.key },
    }));
    return "written";
  } catch (error) {
    if (errorName(error) === "ConditionalCheckFailedException") return "same";
    console.log(JSON.stringify({ component: "broker", event: "second_review.notice_failed", errorName: errorName(error) }));
    return "failed";
  }
}

/** An admin's "I've seen it": the card goes away, and the key is remembered as the last one seen. Only the notice with this key (a newer change is a new notice). */
export async function markNoticeSeen(table: SettingsTable, orgId: string, key: string, at: number): Promise<boolean> {
  try {
    await table.documentClient.send(new UpdateCommand({ TableName: table.tableName, Key: keyFor(orgId), UpdateExpression: "SET #s = :seen, seenAt = :at, lastSeenKey = :key, lastSeenAt = :at", ConditionExpression: "#k = :key AND #s = :open", ExpressionAttributeNames: { "#s": "status", "#k": "key" }, ExpressionAttributeValues: { ":seen": "seen", ":open": "open", ":key": key, ":at": new Date(at).toISOString() } }));
    return true;
  } catch (error) {
    if (errorName(error) === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

/** The words of a notice for the page and the card: the code's sentence, then each model with its reason. */
export function noticeLines(notice: Pick<StoredNotice, "code" | "models">): string[] {
  return [NOTICE_TEXT[notice.code], ...notice.models.slice(0, 5).map((entry) => `${entry.model.modelId}${entry.why === undefined ? "" : `: ${WHY_TEXT[entry.why] ?? "it no longer qualifies"}`}`)];
}

export interface NoticeCardPorts { table: SettingsTable; isAdmin(who: { orgId: string; developerId: string }): Promise<boolean> | boolean }
/** The decision card for an owner or admin while an open notice waits. One card per company; "I've seen it" (on the settings page) puts it away. */
export async function secondReviewNoticeItemsFor(ports: NoticeCardPorts, who: { orgId: string; developerId: string }): Promise<DecisionItem[]> {
  try {
    if (!(await ports.isAdmin(who))) return [];
    const notice = await readNotice(ports.table, who.orgId);
    if (notice === undefined || notice.status !== "open") return [];
    return [{
      kind: "second_review_notice", subjectId: notice.key, project: "Company", title: "Second opinion model", createdAt: notice.createdAt, openPath: "/app/admin/second-review", contentVersion: notice.key,
      message: NOTICE_TEXT[notice.code],
    }];
  } catch { return []; }
}
