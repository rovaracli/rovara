// Convergence S2 (owner decision 60 item S2, plan D3; DECISIONS 181 for the staging run): Cloud's two string sets become one marker row per entry, because
// Code's document store has no sets and the core counts limits by rows (`core/task-flow/keys.ts` `chargeMarkerKey`).
//
//   - Workspace limits: a member counter's `tasks` set (`DEVELOPER_LIMIT#<developer>/MEMBER`, `ORG#<org>#SLACK_LIMIT#<team>/MEMBER#<user>`) becomes one
//     `DEVELOPER_LIMIT_TASK` row per task, `TASK#<taskId>` in the counter's partition, naming the counter in `memberSk`. BOTH counter families move, so
//     the move does not depend on which family a Slack-started core task charges (D3 chose the person's: cloud/rows/core-rows.ts CORE_LIMIT_FAMILY).
//     The count is not touched: it already counts the task. Organization counters never held a set.
//   - Parked deliveries: a SESSION item's `waitingOutboxIds` set becomes one `SESSION_WAITING` row per outbox record (aws/sessions.ts).
//
// Why part of this is a `native` plan: the port has no set operation and refuses to read a row that holds one, so the fence ("this member is still in the
// set") and the removal ("take exactly this member out") cannot be said as port steps. Each item here is ONE entry (a task, a parked outbox id), moved in
// one DynamoDB transaction through the move's own client: put the marker only if absent, delete the entry from the set only if still in it. A member added
// to the set meanwhile is therefore never lost (it stays in the set and the next run moves it), and a member released meanwhile is skipped. Everything
// else (paging, dry run, resume file, conflict list) is the framework's.
//
// Forward items are made from the scanned rows: one item per set member, shaped as the marker it will become (so a conflict's key IS the marker's key).
// Reverse items are the marker rows themselves. The reverse puts EVERY marker back in its set, including markers written after the switch (by the new
// writers or by Code's core): the release before the readers release (0.5.17 and earlier) reads only sets. The release after it (0.5.18) reads both, so a
// rollback to 0.5.18 needs no reverse at all.
import { TransactWriteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { isSlackLimitPk, type StoredDocument } from "@rovara-code/contracts";
import { LIMIT_TASK_ENTITY, LIMIT_TASK_SK_PREFIX } from "../../../developer/limits.js";
import { SESSION_WAITING_ENTITY, sessionWaitingItem, sessionWaitingKey } from "../../../aws/sessions.js";
import type { DataMove, MoveContext, MovePage, MovePlan } from "../framework.js";

type Client = { send(command: unknown): Promise<unknown> };
type Row = Record<string, unknown>;

export const S2_MOVE_ID = "s2-limits-session-markers";
const MIGRATED_FROM = "s2-migration";
const ATTEMPTS = 4;

/** A member counter that may hold a `tasks` set: a developer's own, or a Slack team member's. Organization counters never held one. */
export function isMemberCounter(row: Row): boolean {
  const pk = row["pk"], sk = row["sk"];
  if (typeof pk !== "string" || typeof sk !== "string") return false;
  if (pk.startsWith("DEVELOPER_LIMIT#") && sk === "MEMBER") return true;
  return isSlackLimitPk(pk) && sk.startsWith("MEMBER#");
}

const isSession = (row: Row): boolean => typeof row["pk"] === "string" && row["pk"].startsWith("WORKSPACE#") && row["sk"] === "SESSION";

const members = (value: unknown): string[] => (value instanceof Set ? [...value].filter((entry): entry is string => typeof entry === "string").sort() : []);

const cancelled = (error: unknown): boolean => error instanceof Error && (error.name === "TransactionCanceledException" || error.name === "ConditionalCheckFailedException");
const transient = (error: unknown): boolean => error instanceof Error && ["TransactionConflictException", "ProvisionedThroughputExceededException", "ThrottlingException", "RequestLimitExceeded", "InternalServerError"].includes(error.name);
const reasonCodes = (error: unknown): string[] => {
  const reasons = (error as { CancellationReasons?: Array<{ Code?: string } | undefined> } | null)?.CancellationReasons;
  return Array.isArray(reasons) ? reasons.map((reason) => reason?.Code ?? "None") : [];
};
/** Cancellation reasons that mean "try again": a lost race or a throttle, not a refused condition. */
const RETRY_REASONS = new Set(["TransactionConflict", "ProvisionedThroughputExceeded", "ThrottlingError"]);

export interface LimitMarkerMoveOptions {
  /** DynamoDB document client (set values read and written as Sets) and the State table. Never the port: it cannot hold a set. */
  client: Client;
  tableName: string;
  /** Rows that hold a `tasks` or a `waitingOutboxIds` attribute (a table scan; cursor-paged), as the document client reads them (sets as `Set`). */
  scanSets: (context: MoveContext, cursor: string | undefined) => Promise<MovePage>;
  /** Marker rows of both kinds (`entityType` `DEVELOPER_LIMIT_TASK` or `SESSION_WAITING`). */
  scanMarkers: (context: MoveContext, cursor: string | undefined) => Promise<MovePage>;
  /** Waits before a retry. Default: a timer. */
  sleep?: (ms: number) => Promise<void>;
}

/** The marker an entry becomes, as the forward item the runner plans: the marker's own key and fields, plus where the entry comes from. */
function forwardItems(row: Row): StoredDocument[] {
  const pk = String(row["pk"]), sk = String(row["sk"]);
  if (isMemberCounter(row) && row["tasks"] instanceof Set) {
    return members(row["tasks"]).map((taskId) => ({ pk, sk: `${LIMIT_TASK_SK_PREFIX}${taskId}`, entityType: LIMIT_TASK_ENTITY, taskId, memberSk: sk }));
  }
  if (isSession(row) && row["waitingOutboxIds"] instanceof Set) {
    const workspaceId = pk.slice("WORKSPACE#".length);
    return members(row["waitingOutboxIds"]).map((outboxId) => ({ ...sessionWaitingKey(workspaceId, outboxId), entityType: SESSION_WAITING_ENTITY, workspaceId, outboxId }));
  }
  return [];
}

export function limitMarkerMove(options: LimitMarkerMoveOptions): DataMove {
  const { client, tableName } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const read = async (key: { pk: string; sk: string }): Promise<Row | undefined> =>
    ((await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))) as { Item?: Row }).Item;

  /**
   * One conditional transaction. True when it applied. False ONLY when a condition refused it (a ConditionalCheckFailed reason, or the plain exception),
   * which the runner reads as "the item changed". A lost race or a throttle is tried again (bounded), then thrown; a validation error, a size limit or
   * any other fault is thrown at once, so it can never be counted as "changed under the move".
   */
  const transact = async (items: unknown[]): Promise<boolean> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await client.send(new TransactWriteCommand({ TransactItems: items as never }));
        return true;
      } catch (error) {
        const codes = reasonCodes(error);
        // Any reason that is a fault (a validation error, a size limit, one this code does not know) is thrown, whatever else the cancellation says.
        const fault = cancelled(error) && codes.some((code) => code !== "None" && code !== "ConditionalCheckFailed" && !RETRY_REASONS.has(code));
        if (fault) throw error;
        // A refused condition: the plain exception, or a ConditionalCheckFailed reason.
        if (cancelled(error) && (codes.length === 0 || codes.includes("ConditionalCheckFailed"))) return false;
        const retry = transient(error) || cancelled(error);
        if (retry && attempt < ATTEMPTS) { await sleep(50 * attempt); continue; }
        throw error;
      }
    }
  };

  /** The counter or session row that holds (forward) or should receive (reverse) an entry, and the entry's name. */
  const holderOf = (item: StoredDocument): { key: { pk: string; sk: string }; attribute: "tasks" | "waitingOutboxIds"; entry: string } | undefined => {
    if (item["entityType"] === LIMIT_TASK_ENTITY) {
      const memberSk = item["memberSk"], taskId = item["taskId"];
      // A marker with no `memberSk` (Code's core wrote it before it named one) is the per-developer counter's, where the partition alone says whose it is.
      const sk = typeof memberSk === "string" ? memberSk : item.pk.startsWith("DEVELOPER_LIMIT#") ? "MEMBER" : undefined;
      return typeof taskId === "string" && sk !== undefined ? { key: { pk: item.pk, sk }, attribute: "tasks", entry: taskId } : undefined;
    }
    if (item["entityType"] === SESSION_WAITING_ENTITY) {
      const workspaceId = item["workspaceId"], outboxId = item["outboxId"];
      return typeof workspaceId === "string" && typeof outboxId === "string" && item.pk === `WORKSPACE#${workspaceId}` ? { key: { pk: `WORKSPACE#${workspaceId}`, sk: "SESSION" }, attribute: "waitingOutboxIds", entry: outboxId } : undefined;
    }
    return undefined;
  };

  async function planForward(item: StoredDocument, context: MoveContext): Promise<MovePlan> {
    const holder = holderOf(item);
    if (holder === undefined) return { kind: "conflict", reason: "a forward item that names no counter or session" };
    const row = await read(holder.key);
    if (row === undefined || !members(row[holder.attribute]).includes(holder.entry)) return { kind: "skip", reason: "no longer in the set" };
    if ((await read({ pk: item.pk, sk: item.sk })) !== undefined) return { kind: "conflict", reason: "in the set and already a marker row" };
    const at = context.now().toISOString();
    const marker: Row = item["entityType"] === LIMIT_TASK_ENTITY
      ? { pk: item.pk, sk: item.sk, entityType: LIMIT_TASK_ENTITY, taskId: holder.entry, memberSk: holder.key.sk, chargedAt: at, migratedFrom: MIGRATED_FROM }
      : { ...sessionWaitingItem(holder.key.pk.slice("WORKSPACE#".length), holder.entry, at), migratedFrom: MIGRATED_FROM };
    return { kind: "native", apply: () => transact([
      { Put: { TableName: tableName, Item: marker, ConditionExpression: "attribute_not_exists(pk)" } },
      { Update: { TableName: tableName, Key: holder.key, UpdateExpression: "DELETE #set :entry", ConditionExpression: "contains(#set, :id)", ExpressionAttributeNames: { "#set": holder.attribute }, ExpressionAttributeValues: { ":entry": new Set([holder.entry]), ":id": holder.entry } } },
    ]) };
  }

  async function planReverse(item: StoredDocument): Promise<MovePlan> {
    const holder = holderOf(item);
    if (holder === undefined) return { kind: "conflict", reason: "orphan: the marker names no counter or session" };
    const row = await read(holder.key);
    if (row === undefined || (holder.attribute === "tasks" ? !isMemberCounter(row) : !isSession(row))) return { kind: "conflict", reason: "orphan: its counter or session is gone" };
    if (members(row[holder.attribute]).includes(holder.entry)) return { kind: "conflict", reason: "in the set and a marker row" };
    // A deleted session takes no parked delivery (markDeleted removes its markers): putting one back would leave a set on a dead session. Left for a person.
    const session = holder.attribute === "waitingOutboxIds";
    if (session && row["state"] === "DELETED") return { kind: "conflict", reason: "orphan: its session is deleted" };
    return { kind: "native", apply: () => transact([
      { Update: { TableName: tableName, Key: holder.key, UpdateExpression: "ADD #set :entry",
        // For a session the same fence as the plan: not a deleted one (the state is read here, so a session deleted between the plan and the write refuses it).
        ConditionExpression: session ? "attribute_exists(pk) AND NOT contains(#set, :id) AND #state <> :deleted" : "attribute_exists(pk) AND NOT contains(#set, :id)",
        ExpressionAttributeNames: { "#set": holder.attribute, ...(session ? { "#state": "state" } : {}) },
        ExpressionAttributeValues: { ":entry": new Set([holder.entry]), ":id": holder.entry, ...(session ? { ":deleted": "DELETED" } : {}) } } },
      { Delete: { TableName: tableName, Key: { pk: item.pk, sk: item.sk }, ConditionExpression: "attribute_exists(pk)" } },
    ]) };
  }

  return {
    id: S2_MOVE_ID,
    title: "Limits and session sets to marker rows (S2; table-wide: every row of the table, --company is ignored)",
    status: "ready",
    source: {
      forward: async (context, cursor) => {
        const page = await options.scanSets(context, cursor);
        return { items: page.items.flatMap((row) => forwardItems(row as Row)), ...(page.cursor === undefined ? {} : { cursor: page.cursor }) };
      },
      reverse: options.scanMarkers,
    },
    // The port refuses a row that holds a set, so a refused write re-reads the one entry through the client: the same forward item while it is still in
    // the set, nothing once it is not.
    async reread(item, direction) {
      if (direction === "reverse") {
        const marker = await read({ pk: item.pk, sk: item.sk });
        return marker === undefined ? undefined : (marker as StoredDocument);
      }
      const holder = holderOf(item);
      const row = holder === undefined ? undefined : await read(holder.key);
      return holder !== undefined && row !== undefined && members(row[holder.attribute]).includes(holder.entry) ? item : undefined;
    },
    plan(item, direction, context) {
      return direction === "forward" ? planForward(item, context) : planReverse(item);
    },
  };
}
