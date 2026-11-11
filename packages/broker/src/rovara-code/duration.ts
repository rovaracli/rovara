// Rovara Code (Plan 6 Task 7): how long a plan's work is expected to take, shown beside its cost as an estimate. The figures come from nowhere but the project's own recent tasks
// (the newest `DURATION_HISTORY_SIZE` of them, kept in one item per project and path) or, with fewer than `DURATION_MIN_SAMPLES`, the defaults (`DEFAULT_RUN_MINUTES`).
// Every figure is a whole number of minutes between 5 and `RUN_MINUTES_MAX`, so what a person reads is bounded and never a made-up number. Only version 2 tasks (1.1.0) are
// recorded; a version 1 task writes nothing. A duration is one item and costs no model call: this is not a spend path.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_RUN_MINUTES, DURATION_HISTORY_SIZE, DURATION_MIN_SAMPLES, INDEX_EXPIRY_ATTRIBUTE, RUN_MINUTES_MAX, durationHistoryKey, type OrgId, type RunMinutes } from "@rovara-code/contracts";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import { taskKey } from "../developer/task-records.js";
import { NOT_EXISTS, errorName } from "../agents/table-writes.js";

type Item = Record<string, unknown>;
export interface DurationDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
}

/** The paths a duration is kept for. */
export type DurationPath = "QUICK" | "FULL";

/** How long a project's duration history is kept after its last write (the table's expiry). */
const DURATION_KEPT_SECONDS = 365 * 24 * 60 * 60;
/** How many times a write that met another task's write at the same moment reads the history again before it gives up. */
const RECORD_ATTEMPTS_MAX = 4;
const FIVE = 5;

/** `minutes` (above zero) rounded up to five, so never less than five, and never more than the bound. */
const roundUpToFive = (minutes: number): number => Math.min(RUN_MINUTES_MAX, Math.ceil(minutes / FIVE) * FIVE);

/** The `percent`th percentile by nearest rank: the `ceil(percent × n / 100)`-th smallest. Whole percents keep the product exact. */
function nearestRank(sorted: readonly number[], percent: number): number {
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((percent * sorted.length) / 100)));
  return sorted[rank - 1]!;
}

const isMinutes = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** The durations a history item holds, newest first: the newest `DURATION_HISTORY_SIZE` valid ones. A stored value that is not a positive number is left out; a value above the bound is bounded when it is rounded. */
function durationsOf(item: Item | undefined): number[] {
  const stored = item?.["durations"];
  if (!Array.isArray(stored)) return [];
  return stored.filter(isMinutes).slice(0, DURATION_HISTORY_SIZE);
}

async function readHistory(deps: DurationDependencies, orgId: OrgId, project: string, path: DurationPath): Promise<Item | undefined> {
  const key = durationHistoryKey(orgId, project, path);
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Item };
  return response.Item;
}

/**
 * How long a task of this project and path is expected to take to reach its pull request: p50 and p80 by nearest rank over the project's newest durations once there are
 * `DURATION_MIN_SAMPLES` of them, each rounded up to five minutes; otherwise the default for the path. An unreadable history is an error, never a quieter default.
 */
export async function estimateDuration(deps: DurationDependencies, input: { orgId: OrgId; project: string; path: DurationPath }): Promise<RunMinutes> {
  const durations = durationsOf(await readHistory(deps, input.orgId, input.project, input.path));
  if (durations.length < DURATION_MIN_SAMPLES) {
    const fallback = DEFAULT_RUN_MINUTES[input.path];
    return { low: fallback.low, high: fallback.high, basis: "default", samples: durations.length };
  }
  const sorted = [...durations].sort((a, b) => a - b);
  return { low: roundUpToFive(nearestRank(sorted, 50)), high: roundUpToFive(nearestRank(sorted, 80)), basis: "history", samples: durations.length };
}

/** A task as the duration code reads it. */
export type DurationTask = Pick<DeveloperTaskRecord, "taskId" | "orgId" | "project" | "workflow" | "durationRecordedAt">;

/**
 * Writes how long a version 2 task took (from its workflow's start to `endedAt`, whole minutes rounded up, at least 1 and at most the bound) at the front of its project's
 * history, and marks the task, in one transaction: a task is counted once however often its end is told. The history is conditioned on the version that was read, so two
 * tasks ending together both land (the loser reads again). Not recorded: a task that is not version 2, has no org, or whose end is not after its start (`skipped`).
 */
export async function recordTaskDuration(deps: DurationDependencies, task: DurationTask, input: { endedAt: string }): Promise<"recorded" | "already_recorded" | "skipped"> {
  const workflow = task.workflow;
  if (task.orgId === undefined || workflow === undefined || workflow.definitionVersion !== "1.1.0") return "skipped";
  if (task.durationRecordedAt !== undefined) return "already_recorded";
  const started = Date.parse(workflow.createdAt);
  const ended = Date.parse(input.endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return "skipped";
  const minutes = Math.min(RUN_MINUTES_MAX, Math.max(1, Math.ceil((ended - started) / 60_000)));
  const orgId = task.orgId;
  const path = workflow.path;
  for (let attempt = 1; ; attempt += 1) {
    const current = await readHistory(deps, orgId, task.project, path);
    const version = typeof current?.["version"] === "number" ? current["version"] : 0;
    const history = {
      ...durationHistoryKey(orgId, task.project, path), entityType: "DURATION_HISTORY",
      orgId, project: task.project, path, durations: [minutes, ...durationsOf(current)].slice(0, DURATION_HISTORY_SIZE), version: version + 1, updatedAt: input.endedAt,
      [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(ended / 1000) + DURATION_KEPT_SECONDS,
    };
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Put: {
          TableName: deps.tableName, Item: history,
          ...(current === undefined ? { ConditionExpression: NOT_EXISTS } : { ConditionExpression: "#version = :version", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":version": version } }),
        } },
        { Update: {
          TableName: deps.tableName, Key: taskKey(task.taskId),
          UpdateExpression: "SET durationRecordedAt = :at", ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(durationRecordedAt)",
          ExpressionAttributeValues: { ":at": input.endedAt },
        } },
      ] }));
      return "recorded";
    } catch (error) {
      if (errorName(error) !== "TransactionCanceledException") throw error;
      // A cancellation can mean this task was counted meanwhile (its mark is on the task now), or the history moved. Read the mark again before deciding.
      const fresh = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(task.taskId), ConsistentRead: true })) as { Item?: Item };
      if (fresh.Item === undefined) return "skipped";
      if (fresh.Item["durationRecordedAt"] !== undefined) return "already_recorded";
      if (attempt >= RECORD_ATTEMPTS_MAX) throw error;
    }
  }
}

/** `recordTaskDuration` for an end the caller must not fail on: a duration that can't be written is logged and left for the next end to try again. */
export async function noteTaskDuration(deps: DurationDependencies, task: DurationTask, endedAt: string): Promise<void> {
  try {
    await recordTaskDuration(deps, task, { endedAt });
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "duration.not_recorded", taskId: task.taskId, error: errorName(error) ?? "unknown" }));
  }
}

/**
 * The pull request just opened: when every pull request the task needs is in (it now waits for the merge), its duration is written, dated now. Reads the task afresh. Never
 * fails the result it follows.
 */
export async function noteDurationAtPullRequest(deps: DurationDependencies, taskId: string, endedAt: string): Promise<void> {
  try {
    const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(taskId), ConsistentRead: true })) as { Item?: DeveloperTaskRecord };
    const task = response.Item;
    if (task?.workflow?.stage !== "WAIT_FOR_MERGE") return;
    await noteTaskDuration(deps, task, endedAt);
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "duration.not_recorded", taskId, error: errorName(error) ?? "unknown" }));
  }
}

/**
 * A finished task whose duration is still owed (its pull request's write was lost, or it ended without a pull request): written when it is released, dated by its last
 * change, as `recordFinishedRunCost` dates a cost. Counts a merge, a program that passed every step and a question that was answered; a rejected plan or a close is not a
 * task that ran.
 */
export async function noteFinishedTaskDuration(deps: DurationDependencies, task: DurationTask): Promise<void> {
  const workflow = task.workflow;
  if (workflow === undefined || workflow.state !== "COMPLETE" || task.durationRecordedAt !== undefined) return;
  const ran = (workflow.stage === "MERGED" && workflow.outcome === "MERGED") || (workflow.stage === "CLOSED" && (workflow.outcome === "PASSED" || workflow.outcome === "ANSWERED"));
  if (ran) await noteTaskDuration(deps, task, workflow.updatedAt);
}
