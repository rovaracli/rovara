// Convergence lane A5, the one-time data migration of owner decision 60 item S2 (convergence plan D3): Cloud's string sets become one marker item per entry.
//
//   - Workspace limits: a member counter's `tasks` set (`DEVELOPER_LIMIT#<developer>/MEMBER`, `ORG#<org>#SLACK_LIMIT#<team>/MEMBER#<user>`) becomes one
//     `DEVELOPER_LIMIT_TASK` marker per task, `TASK#<taskId>` in the counter's partition, naming the counter in `memberSk` (developer/limits.ts). The count
//     is not touched: it already counts the task.
//   - Parked deliveries: a SESSION item's `waitingOutboxIds` set becomes one `SESSION_WAITING` marker per outbox record (aws/sessions.ts).
//
// The writers and readers of this release already speak both forms, so the migration can run while the release is live; it should run when no task is
// starting (a release racing it is refused and retried, never counted twice). Each entry moves in its own transaction: the marker is put only if absent and the
// entry leaves the set only if still in it, so a run can stop anywhere and be run again (idempotent, resumable with the printed key). `reverse` undoes it for
// a rollback to the release before this one, which reads only the sets: every marker (migrated or written since) goes back into its set, and the stored rows
// are then exactly as they were (the count was never touched; the migrated markers are deleted). Without `apply` nothing is written: the counts say what a
// run would do. The output is counts only, never an id.
import { GetCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { isSlackLimitPk } from "@rovara-code/contracts";
import { LIMIT_TASK_ENTITY, LIMIT_TASK_SK_PREFIX } from "../developer/limits.js";
import { SESSION_WAITING_ENTITY, sessionWaitingItem, sessionWaitingKey } from "../aws/sessions.js";

type Client = { send(command: unknown): Promise<unknown> };
type Item = Record<string, unknown>;

export interface S2Dependencies {
  documentClient: Client;
  tableName: string;
  /** Epoch milliseconds. */
  now: () => number;
  /** Waits between pages (and before a retry). Default: a timer. */
  sleep?: (ms: number) => Promise<void>;
}

export interface S2Options {
  direction: "forward" | "reverse";
  /** Without it nothing is written. */
  apply: boolean;
  pageSize: number;
  /** Stops after the page that passes this many milliseconds and answers the key to resume from. */
  maxMs: number;
  pauseMs: number;
  start?: Record<string, unknown> | undefined;
}

/** What a run found and did. `moved` is what it wrote (or, without `apply`, would write). */
export interface S2Counts {
  scanned: number;
  limitCounters: number;
  limitEntries: number;
  limitMoved: number;
  /** Forward: already a marker and no longer in the set (an earlier run). Reverse: already in the set and no marker. */
  limitAlready: number;
  /** In both forms at once, or a write refused for a reason other than an earlier run: left as it is, for a person to look at. */
  limitConflicts: number;
  /** Reverse only: a marker whose counter is missing or cannot be named. Left as it is. */
  limitOrphans: number;
  sessions: number;
  sessionEntries: number;
  sessionMoved: number;
  sessionAlready: number;
  sessionConflicts: number;
  sessionOrphans: number;
}

export interface S2Result {
  direction: S2Options["direction"];
  applied: boolean;
  finished: boolean;
  counts: S2Counts;
  /** The key to pass as `start` to go on, when the run stopped early. */
  resume?: Record<string, unknown>;
}

const MIGRATED_FROM = "s2-migration";
const ATTEMPTS = 4;

const emptyCounts = (): S2Counts => ({
  scanned: 0, limitCounters: 0, limitEntries: 0, limitMoved: 0, limitAlready: 0, limitConflicts: 0, limitOrphans: 0,
  sessions: 0, sessionEntries: 0, sessionMoved: 0, sessionAlready: 0, sessionConflicts: 0, sessionOrphans: 0,
});

/** A member counter that may hold an old `tasks` set: a developer's own, or a Slack team member's. Organization counters never held one. */
export function isMemberCounter(item: Item): boolean {
  const pk = item["pk"], sk = item["sk"];
  if (typeof pk !== "string" || typeof sk !== "string") return false;
  if (pk.startsWith("DEVELOPER_LIMIT#") && sk === "MEMBER") return true;
  return isSlackLimitPk(pk) && sk.startsWith("MEMBER#");
}

const isSession = (item: Item): boolean => typeof item["pk"] === "string" && (item["pk"]).startsWith("WORKSPACE#") && item["sk"] === "SESSION";

const setEntries = (value: unknown): string[] => (value instanceof Set ? [...value].filter((entry): entry is string => typeof entry === "string").sort() : []);

const cancelled = (error: unknown): boolean => error instanceof Error && (error.name === "TransactionCanceledException" || error.name === "ConditionalCheckFailedException");
const transient = (error: unknown): boolean => error instanceof Error && ["TransactionConflictException", "ProvisionedThroughputExceededException", "ThrottlingException", "RequestLimitExceeded", "InternalServerError"].includes(error.name);
const conflictOnly = (error: unknown): boolean => {
  const reasons = (error as { CancellationReasons?: Array<{ Code?: string } | undefined> } | null)?.CancellationReasons;
  return Array.isArray(reasons) && reasons.some((reason) => reason?.Code === "TransactionConflict") && !reasons.some((reason) => reason?.Code === "ConditionalCheckFailed");
};

async function read(deps: S2Dependencies, key: { pk: string; sk: string }): Promise<Item | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;
}

/** Sends one entry's transaction; a lost race or a throttle is tried again (bounded). Answers false when a condition refused it. */
async function write(deps: S2Dependencies, items: Item[]): Promise<boolean> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
      return true;
    } catch (error) {
      const retry = transient(error) || (cancelled(error) && conflictOnly(error));
      if (retry && attempt < ATTEMPTS) { await (deps.sleep ?? defaultSleep)(50 * attempt); continue; }
      if (cancelled(error) && !conflictOnly(error)) return false;
      throw error;
    }
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---- forward: set entries to markers ----

async function forwardLimit(deps: S2Dependencies, apply: boolean, counter: Item, counts: S2Counts, at: string): Promise<void> {
  const key = { pk: String(counter["pk"]), sk: String(counter["sk"]) };
  counts.limitCounters += 1;
  for (const taskId of setEntries(counter["tasks"])) {
    counts.limitEntries += 1;
    const markerKey = { pk: key.pk, sk: `${LIMIT_TASK_SK_PREFIX}${taskId}` };
    if ((await read(deps, markerKey)) !== undefined) { counts.limitConflicts += 1; continue; }
    if (!apply) { counts.limitMoved += 1; continue; }
    const moved = await write(deps, [
      { Put: { TableName: deps.tableName, Item: { ...markerKey, entityType: LIMIT_TASK_ENTITY, taskId, memberSk: key.sk, chargedAt: at, migratedFrom: MIGRATED_FROM }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Update: { TableName: deps.tableName, Key: key, UpdateExpression: "DELETE #tasks :entry", ConditionExpression: "contains(#tasks, :id)", ExpressionAttributeNames: { "#tasks": "tasks" }, ExpressionAttributeValues: { ":entry": new Set([taskId]), ":id": taskId } } },
    ]);
    if (moved) { counts.limitMoved += 1; continue; }
    // Refused: an earlier run (or a release) moved it meanwhile, or both forms exist.
    if (!setEntries((await read(deps, key))?.["tasks"]).includes(taskId)) counts.limitAlready += 1;
    else counts.limitConflicts += 1;
  }
}

async function forwardSession(deps: S2Dependencies, apply: boolean, session: Item, counts: S2Counts, at: string): Promise<void> {
  const key = { pk: String(session["pk"]), sk: "SESSION" };
  const workspaceId = key.pk.slice("WORKSPACE#".length);
  counts.sessions += 1;
  for (const outboxId of setEntries(session["waitingOutboxIds"])) {
    counts.sessionEntries += 1;
    const markerKey = sessionWaitingKey(workspaceId, outboxId);
    if ((await read(deps, markerKey)) !== undefined) { counts.sessionConflicts += 1; continue; }
    if (!apply) { counts.sessionMoved += 1; continue; }
    const moved = await write(deps, [
      { Put: { TableName: deps.tableName, Item: { ...sessionWaitingItem(workspaceId, outboxId, at), migratedFrom: MIGRATED_FROM }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Update: { TableName: deps.tableName, Key: key, UpdateExpression: "DELETE #waiting :entry", ConditionExpression: "contains(#waiting, :id)", ExpressionAttributeNames: { "#waiting": "waitingOutboxIds" }, ExpressionAttributeValues: { ":entry": new Set([outboxId]), ":id": outboxId } } },
    ]);
    if (moved) { counts.sessionMoved += 1; continue; }
    // Refused: released meanwhile (the record left the set), or both forms exist.
    if (!setEntries((await read(deps, key))?.["waitingOutboxIds"]).includes(outboxId)) counts.sessionAlready += 1;
    else counts.sessionConflicts += 1;
  }
}

// ---- reverse: markers back into sets ----

/** The member counter a limit marker belongs to: the one it names, or, for a marker that names none, the per-developer counter its partition is. */
function counterOfMarker(marker: Item): { pk: string; sk: string } | undefined {
  const pk = marker["pk"];
  if (typeof pk !== "string") return undefined;
  const memberSk = marker["memberSk"];
  if (typeof memberSk === "string") return { pk, sk: memberSk };
  return pk.startsWith("DEVELOPER_LIMIT#") ? { pk, sk: "MEMBER" } : undefined;
}

async function reverseLimit(deps: S2Dependencies, apply: boolean, marker: Item, counts: S2Counts): Promise<void> {
  counts.limitEntries += 1;
  const taskId = marker["taskId"];
  const counterKey = counterOfMarker(marker);
  const counter = counterKey === undefined ? undefined : await read(deps, counterKey);
  if (typeof taskId !== "string" || counterKey === undefined || counter === undefined || !isMemberCounter(counter)) { counts.limitOrphans += 1; return; }
  if (setEntries(counter["tasks"]).includes(taskId)) { counts.limitConflicts += 1; return; }
  if (!apply) { counts.limitMoved += 1; return; }
  const moved = await write(deps, [
    { Update: { TableName: deps.tableName, Key: counterKey, UpdateExpression: "ADD #tasks :entry", ConditionExpression: "attribute_exists(pk) AND NOT contains(#tasks, :id)", ExpressionAttributeNames: { "#tasks": "tasks" }, ExpressionAttributeValues: { ":entry": new Set([taskId]), ":id": taskId } } },
    { Delete: { TableName: deps.tableName, Key: { pk: String(marker["pk"]), sk: String(marker["sk"]) }, ConditionExpression: "attribute_exists(pk)" } },
  ]);
  if (moved) { counts.limitMoved += 1; return; }
  if ((await read(deps, { pk: String(marker["pk"]), sk: String(marker["sk"]) })) === undefined) counts.limitAlready += 1;
  else counts.limitConflicts += 1;
}

async function reverseSession(deps: S2Dependencies, apply: boolean, marker: Item, counts: S2Counts): Promise<void> {
  counts.sessionEntries += 1;
  const outboxId = marker["outboxId"], workspaceId = marker["workspaceId"];
  const sessionKey = typeof workspaceId === "string" ? { pk: `WORKSPACE#${workspaceId}`, sk: "SESSION" } : undefined;
  const session = sessionKey === undefined ? undefined : await read(deps, sessionKey);
  if (typeof outboxId !== "string" || sessionKey === undefined || session === undefined || marker["pk"] !== sessionKey.pk) { counts.sessionOrphans += 1; return; }
  if (setEntries(session["waitingOutboxIds"]).includes(outboxId)) { counts.sessionConflicts += 1; return; }
  if (!apply) { counts.sessionMoved += 1; return; }
  const moved = await write(deps, [
    { Update: { TableName: deps.tableName, Key: sessionKey, UpdateExpression: "ADD #waiting :entry", ConditionExpression: "attribute_exists(pk) AND NOT contains(#waiting, :id)", ExpressionAttributeNames: { "#waiting": "waitingOutboxIds" }, ExpressionAttributeValues: { ":entry": new Set([outboxId]), ":id": outboxId } } },
    { Delete: { TableName: deps.tableName, Key: { pk: String(marker["pk"]), sk: String(marker["sk"]) }, ConditionExpression: "attribute_exists(pk)" } },
  ]);
  if (moved) { counts.sessionMoved += 1; return; }
  if ((await read(deps, { pk: String(marker["pk"]), sk: String(marker["sk"]) })) === undefined) counts.sessionAlready += 1;
  else counts.sessionConflicts += 1;
}

/**
 * Runs the migration (or its reverse) over the whole table, a page of the scan at a time, until the end or `maxMs`. The scan's filter keeps only what
 * can move: items holding one of the two sets (forward), or the two marker kinds (reverse).
 */
export async function migrateS2MarkerRows(deps: S2Dependencies, options: S2Options): Promise<S2Result> {
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 1_000) throw new RangeError("pageSize must be 1 to 1000");
  const counts = emptyCounts();
  const began = deps.now();
  const at = new Date(began).toISOString();
  let start = options.start;
  for (;;) {
    const page = (await deps.documentClient.send(new ScanCommand({
      TableName: deps.tableName, Limit: options.pageSize, ConsistentRead: true,
      ...(options.direction === "forward"
        ? { FilterExpression: "attribute_exists(#tasks) OR attribute_exists(#waiting)", ExpressionAttributeNames: { "#tasks": "tasks", "#waiting": "waitingOutboxIds" } }
        : { FilterExpression: "#type = :limit OR #type = :waiting", ExpressionAttributeNames: { "#type": "entityType" }, ExpressionAttributeValues: { ":limit": LIMIT_TASK_ENTITY, ":waiting": SESSION_WAITING_ENTITY } }),
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    }))) as { Items?: Item[]; ScannedCount?: number; LastEvaluatedKey?: Record<string, unknown> };
    counts.scanned += page.ScannedCount ?? 0;
    for (const item of page.Items ?? []) {
      if (options.direction === "forward") {
        if (isMemberCounter(item) && item["tasks"] instanceof Set) await forwardLimit(deps, options.apply, item, counts, at);
        else if (isSession(item) && item["waitingOutboxIds"] instanceof Set) await forwardSession(deps, options.apply, item, counts, at);
      } else if (item["entityType"] === LIMIT_TASK_ENTITY) await reverseLimit(deps, options.apply, item, counts);
      else if (item["entityType"] === SESSION_WAITING_ENTITY) await reverseSession(deps, options.apply, item, counts);
    }
    start = page.LastEvaluatedKey;
    if (start === undefined) return { direction: options.direction, applied: options.apply, finished: true, counts };
    if (deps.now() - began >= options.maxMs) return { direction: options.direction, applied: options.apply, finished: false, counts, resume: start };
    if (options.pauseMs > 0) await (deps.sleep ?? defaultSleep)(options.pauseMs);
  }
}
