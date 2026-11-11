// Track record (v1.2, slice 1): the outcome store. A sample is one confident claim in one round of one task (contracts/src/outcomes.ts). It is written pending under
// `ORG#<org>#OUTCOME#<project>#<stage>` with a key that holds its round, so a retry or a duplicate event never makes a second one, and it is scored once, by a write that holds only
// while the sample is still pending. Scoring also writes a copy under `OUTCOME_SCORED#...` keyed by the score time, so the rate reads exactly the last 30 days by score time.
//
// Every write here is best effort: a failure is logged with a fixed code, counted on a metric and answered as "nothing written"; nothing in this file throws on a write, so it can never
// block the flow it records. Only the broker calls it; nothing a worker or an agent sends reaches it. The rows hold ids, enums and timestamps only.
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, OUTCOME_ENOUGH_SAMPLES, OUTCOME_PENDING_KEPT_DAYS, OUTCOME_READ_CAP, OUTCOME_READ_PAGE, OUTCOME_SCORED_KEPT_DAYS, OUTCOME_WINDOW_DAYS, OutcomeSampleSchema, OutcomeScoreSchema, outcomeSampleKey, outcomeScoredKey, type OrgId, type OutcomeClaim, type OutcomeRate, type OutcomeSample, type OutcomeSampleKey, type OutcomeScore, type OutcomeStage } from "@rovara-code/contracts";
import { NOT_EXISTS, errorName } from "../agents/table-writes.js";

export interface OutcomeDependencies {
  ddb: { send(command: unknown): Promise<unknown> };
  tableName: string;
  log?(event: string, fields: Record<string, unknown>): void;
  /** Counts something that went wrong (a metric of the broker's own); a failed write is counted as `OutcomeWriteFailed`. */
  metric?(name: string, value?: number): void;
}

export const OUTCOME_WRITE_FAILED_METRIC = "OutcomeWriteFailed";
const DAY_MS = 24 * 60 * 60 * 1000;
const NO_KEY: OutcomeSampleKey = { pk: "", sk: "" };

type Item = Record<string, unknown>;

const expiry = (at: string, days: number): number => Math.floor((Date.parse(at) + days * DAY_MS) / 1000);

function failed(deps: OutcomeDependencies, what: string, error: unknown): void {
  try {
    deps.log?.(`outcomes.${what}_failed`, { error: errorName(error) ?? "unknown" });
    deps.metric?.(OUTCOME_WRITE_FAILED_METRIC, 1);
  } catch {
    // Logging and counting never fail the flow either.
  }
}

/** Whether a transaction was cancelled only because a condition failed (the sample exists already, or is no longer pending). */
function conditionOnly(error: unknown): boolean {
  if (errorName(error) === "ConditionalCheckFailedException") return true;
  if (errorName(error) !== "TransactionCanceledException") return false;
  const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
  return reasons !== undefined && reasons.some((reason) => reason.Code === "ConditionalCheckFailed") && reasons.every((reason) => reason.Code === "ConditionalCheckFailed" || reason.Code === "None" || reason.Code === undefined);
}

function keysOf(sample: Pick<OutcomeSample, "orgId" | "project" | "stage" | "taskId" | "claim" | "round" | "createdAt" | "scoredAt">): { sample: OutcomeSampleKey; scored?: OutcomeSampleKey } {
  const org = sample.orgId;
  return {
    sample: outcomeSampleKey(org, sample.project, sample.stage, sample.createdAt, sample.taskId, sample.claim, sample.round),
    ...(sample.scoredAt === undefined ? {} : { scored: outcomeScoredKey(org, sample.project, sample.stage, sample.scoredAt, sample.taskId, sample.claim, sample.round) }),
  };
}

/** The stored item of a sample: its key, its fields and the expiry (a scored one lives 180 days after `scoredAt`, a pending one a year after `createdAt`). */
function itemOf(key: OutcomeSampleKey, sample: OutcomeSample): Item {
  return { ...key, entityType: "OUTCOME_SAMPLE", ...sample, [INDEX_EXPIRY_ATTRIBUTE]: sample.scoredAt === undefined ? expiry(sample.createdAt, OUTCOME_PENDING_KEPT_DAYS) : expiry(sample.scoredAt, OUTCOME_SCORED_KEPT_DAYS) };
}

const scoredCopy = (key: OutcomeSampleKey, item: Item): Item => ({ ...item, ...key, entityType: "OUTCOME_SCORED" });

/**
 * Writes a sample, once. The key holds the round, so the same claim in the same round of the same task is the same item: a second write finds it and answers `created: false`.
 * A sample that is already scored (the plan check's, written after the person's decision) also gets its scored copy, in the same transaction. Never throws.
 */
export async function recordOutcomeSample(deps: OutcomeDependencies, input: OutcomeSample): Promise<{ key: OutcomeSampleKey; created: boolean }> {
  let sample: OutcomeSample;
  let keys: ReturnType<typeof keysOf>;
  try {
    sample = OutcomeSampleSchema.parse(input);
    keys = keysOf(sample);
  } catch (error) {
    failed(deps, "record", error);
    return { key: NO_KEY, created: false };
  }
  const item = itemOf(keys.sample, sample);
  try {
    if (keys.scored === undefined) {
      await deps.ddb.send(new PutCommand({ TableName: deps.tableName, Item: item, ConditionExpression: NOT_EXISTS }));
    } else {
      await deps.ddb.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: deps.tableName, Item: item, ConditionExpression: NOT_EXISTS } },
        { Put: { TableName: deps.tableName, Item: scoredCopy(keys.scored, item), ConditionExpression: NOT_EXISTS } },
      ] }));
    }
    return { key: keys.sample, created: true };
  } catch (error) {
    if (!conditionOnly(error)) failed(deps, "record", error);
    return { key: keys.sample, created: false };
  }
}

/**
 * Scores a pending sample, once: the sample is replaced with its score, held to `state = pending`, and its scored copy is written, in one transaction. True when this call scored it;
 * false when it was already scored, is not there, or the write failed (the failure is logged and counted). Never throws.
 */
export async function scoreOutcomeSample(deps: OutcomeDependencies, key: OutcomeSampleKey, update: OutcomeScore): Promise<boolean> {
  try {
    const score = OutcomeScoreSchema.parse(update);
    const stored = (await deps.ddb.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Item }).Item;
    if (stored === undefined || stored.entityType !== "OUTCOME_SAMPLE" || stored.state !== "pending") return false;
    const { pk: _pk, sk: _sk, entityType: _entity, [INDEX_EXPIRY_ATTRIBUTE]: _expiry, ...fields } = stored; // eslint-disable-line @typescript-eslint/no-unused-vars -- the key and expiry are rebuilt
    const merged = OutcomeSampleSchema.parse({
      ...fields, ...score,
      ...(score.pr === undefined && fields.pr === undefined ? {} : { pr: { ...(fields.pr as object | undefined), ...score.pr } }),
    });
    const scoredKey = keysOf(merged).scored!;
    const item = itemOf(key, merged);
    try {
      await deps.ddb.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: deps.tableName, Item: item, ConditionExpression: "attribute_exists(pk) AND #state = :pending", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":pending": "pending" } } },
        { Put: { TableName: deps.tableName, Item: scoredCopy(scoredKey, item), ConditionExpression: NOT_EXISTS } },
      ] }));
      return true;
    } catch (error) {
      if (!conditionOnly(error)) failed(deps, "score", error);
      return false;
    }
  } catch (error) {
    failed(deps, "score", error);
    return false;
  }
}

/**
 * The record of one claim at one stage: what was scored in the last 30 days, by score time. It reads the stage's scored copies newest first, a page of `OUTCOME_READ_PAGE` at a time,
 * and stops at `OUTCOME_READ_CAP` items (`capped` says there were more). A read that fails throws: the card shows no record, never a zero.
 */
export async function readOutcomeRate(
  deps: OutcomeDependencies, input: { org: OrgId; project: string; stage: OutcomeStage; claim: OutcomeClaim; now: number | string },
): Promise<OutcomeRate> {
  const nowMs = typeof input.now === "number" ? input.now : Date.parse(input.now);
  const from = new Date(nowMs - OUTCOME_WINDOW_DAYS * DAY_MS).toISOString();
  const { pk } = outcomeScoredKey(input.org, input.project, input.stage, from, "t", input.claim, "r");
  const rate: OutcomeRate = { held: 0, notHeld: 0, closedUnmerged: 0, noOutcome: 0, unreviewedMerges: 0, capped: false, enough: false };
  const query = async (limit: number, start: Record<string, unknown> | undefined) => await deps.ddb.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to", ScanIndexForward: false, Limit: limit,
    ExpressionAttributeValues: { ":pk": pk, ":from": from, ":to": "9999" }, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
  })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
  let read = 0;
  let next: Record<string, unknown> | undefined;
  do {
    const page = await query(Math.min(OUTCOME_READ_PAGE, OUTCOME_READ_CAP - read), next);
    for (const item of page.Items ?? []) {
      read += 1;
      if (item.entityType !== "OUTCOME_SCORED" || item.claim !== input.claim) continue;
      if (item.state === "held") { rate.held += 1; if (item.unreviewedMerge === true) rate.unreviewedMerges += 1; }
      else if (item.state === "not_held") rate.notHeld += 1;
      else if (item.state === "closed_unmerged") rate.closedUnmerged += 1;
      else if (item.state === "no_outcome") rate.noOutcome += 1;
    }
    next = page.LastEvaluatedKey;
  } while (next !== undefined && read < OUTCOME_READ_CAP);
  // DynamoDB hands out a start key whenever `Limit` stopped the read, even when nothing is left: one more item says whether the cap cut anything off.
  if (next !== undefined) rate.capped = ((await query(1, next)).Items ?? []).length > 0;
  rate.enough = rate.held + rate.notHeld >= OUTCOME_ENOUGH_SAMPLES;
  return rate;
}
