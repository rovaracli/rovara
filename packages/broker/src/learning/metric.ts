// v1.2 learning loop, B5: the METRIC counters (design 4.3 and 6.4). One item per project and UTC month, `METRIC#<yyyy-mm>`, of the month of the correction's `createdAt`.
//
// The counters are written by the grouping transaction that judges a correction (grouping.ts), in the same transaction that sets its `groupedAt` and `repeatOf` and on the condition that
// `groupedAt` is not set yet, so a correction is counted exactly once and never before its `repeatOf` is known. Nothing here reads `repeatOf` from the correction: the grouping step works it
// out and hands the deltas to `metricUpdateItem`.
//
// PR-comment corrections also add to `pr*` counters that are part of the totals. While PR capture is off the view subtracts them ("stops counting at once", owner decision Q2/Q3), and the
// text is kept. B6 composes `metricUpdateItem` into its settle and dismiss transactions for `accepted` and `dismissed`.
import { DeleteCommand, GetCommand, type TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, projectLearningKey, type OrgId } from "@rovara-code/contracts";
import { sameProject } from "./retention.js";
import { getLearningItem, type LearningDeps, type LearningScope } from "./store.js";

type TransactItem = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>[number];

export const METRIC_COUNTERS = [
  "memberCorrections", "repeats", "repeatsOfAcceptedRules", "suggestions", "accepted", "dismissed", "prMemberCorrections", "prRepeats", "prRepeatsOfAcceptedRules",
] as const;
export type MetricCounter = (typeof METRIC_COUNTERS)[number];
export type MetricCounters = Record<MetricCounter, number>;

/** Below this many member corrections in a month the screen says "Not enough corrections yet" (design 6.4). */
export const METRIC_MIN_CORRECTIONS = 10;

export interface MetricView {
  month: string;
  memberCorrections: number;
  repeats: number;
  /** Repeats whose `repeatOf` names an accepted rule: "Same correction given twice, after a rule". */
  repeatsOfAcceptedRules: number;
  suggestions: number;
  accepted: number;
  dismissed: number;
  /** At least `METRIC_MIN_CORRECTIONS` member corrections this month. */
  enoughData: boolean;
  /** `repeats` over `memberCorrections`, or null when there is not enough data. */
  share: number | null;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const invalid = (what: string) => agentXError("CONFIG_INVALID", `${what} is not valid.`);

/** The UTC `yyyy-mm` of an ISO instant. */
export function metricMonth(createdAtIso: string): string {
  const time = Date.parse(createdAtIso);
  if (!Number.isFinite(time)) throw invalid("The time");
  return new Date(time).toISOString().slice(0, 7);
}

export function metricSk(month: string): string {
  if (!MONTH.test(month)) throw invalid("The month");
  return `METRIC#${month}`;
}

const pcOf = (scope: LearningScope): string => {
  const time = Date.parse(scope.projectCreatedAt);
  if (!Number.isFinite(time)) throw invalid("The project's creation time");
  return new Date(time).toISOString();
};
const keyOf = (scope: { orgId: OrgId; project: string }, sk: string) => projectLearningKey(scope.orgId, scope.project, sk);

/**
 * The write that adds `deltas` to a month's counters, for a caller's transaction. It stamps the item with the project's `projectCreatedAt` and holds only on an item that is absent or the
 * same project's: call `ensureMetricCurrent` first, which clears an earlier project's item. A negative delta takes a count back (Forget).
 */
export function metricUpdateItem(deps: LearningDeps, scope: LearningScope, month: string, deltas: Partial<MetricCounters>): TransactItem {
  const names = METRIC_COUNTERS.filter((name) => (deltas[name] ?? 0) !== 0);
  if (names.length === 0) throw invalid("The metric change");
  const values: Record<string, unknown> = {};
  names.forEach((name, index) => {
    const delta = deltas[name]!;
    if (!Number.isSafeInteger(delta)) throw invalid("The metric change");
    values[`:d${String(index)}`] = delta;
  });
  const projectCreatedAt = pcOf(scope);
  return {
    Update: {
      TableName: deps.tableName, Key: keyOf(scope, metricSk(month)),
      UpdateExpression: `SET entityType = :entity, orgId = :org, projectCreatedAt = :pc ADD ${names.map((name, index) => `${name} :d${String(index)}`).join(", ")}`,
      ConditionExpression: "attribute_not_exists(pk) OR projectCreatedAt = :pc",
      ExpressionAttributeValues: { ":entity": "LEARNING_METRIC", ":org": scope.orgId, ":pc": projectCreatedAt, ...values },
    },
  };
}

/** Clears the month's item when it belongs to an earlier project of the same name, so the next update starts from zero. Nothing happens when it is absent or current. */
export async function ensureMetricCurrent(deps: LearningDeps, scope: LearningScope, month: string): Promise<void> {
  const key = keyOf(scope, metricSk(month));
  const found = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const item = found.Item;
  if (item === undefined || sameProject(item["projectCreatedAt"], scope.projectCreatedAt)) return;
  try {
    await deps.documentClient.send(new DeleteCommand({
      TableName: deps.tableName, Key: key, ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(projectCreatedAt) OR projectCreatedAt <> :pc)", ExpressionAttributeValues: { ":pc": pcOf(scope) },
    }));
  } catch (error) {
    if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error;
  }
}

const count = (item: Record<string, unknown> | undefined, name: MetricCounter): number => {
  const value = item?.[name];
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
};

/** A month's counters for the screen. With `prCaptureOff`, PR-comment corrections are taken out of the totals. An absent month, or one of an earlier project, reads as zeros. */
export async function readMetric(deps: LearningDeps, scope: LearningScope, month: string, options: { prCaptureOff: boolean }): Promise<MetricView> {
  const item = await getLearningItem(deps, scope, metricSk(month));
  const minusPr = (total: MetricCounter, pr: MetricCounter) => Math.max(0, count(item, total) - (options.prCaptureOff ? count(item, pr) : 0));
  const memberCorrections = minusPr("memberCorrections", "prMemberCorrections");
  const repeats = minusPr("repeats", "prRepeats");
  const enoughData = memberCorrections >= METRIC_MIN_CORRECTIONS;
  return {
    month, memberCorrections, repeats, repeatsOfAcceptedRules: minusPr("repeatsOfAcceptedRules", "prRepeatsOfAcceptedRules"),
    suggestions: count(item, "suggestions"), accepted: count(item, "accepted"), dismissed: count(item, "dismissed"),
    enoughData, share: enoughData ? repeats / memberCorrections : null,
  };
}
