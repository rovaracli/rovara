// P6: where the poller keeps the change requests it follows, one item each, in one partition per host kind. A pass reads the partition (at most `MAX_POLL_TARGETS` items) and works
// oldest-due first; saving a target moves its due time, and removing it ends the following. The item for a host's rate limit sits in the same partition.
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ChangeRequestRefSchema, type ChangeRequestRef, type PluginKind } from "@rovara-code/contracts";
import { isConditional } from "../../aws/broker-shared.js";
import { MAX_POLL_TARGETS, type DuePoll, type PollCursor, type PollStore } from "./poller.js";
import { codeHostRepositoryKey } from "./repository-key.js";

type DocumentClient = { send(command: unknown): Promise<unknown> };

const partition = (kind: PluginKind): string => `CODEHOST_POLL#${kind}`;

/** The store's name for a change request, or undefined when its repository address cannot be keyed. */
export function pollTargetId(kind: PluginKind, ref: ChangeRequestRef): string | undefined {
  const repository = codeHostRepositoryKey(kind, ref.repository.url);
  return repository === undefined || /[\p{Cc}\p{Cf}]/u.test(ref.id) ? undefined : `${repository}|${ref.id}`;
}

export interface PollRegistry extends PollStore {
  /** Starts following a change request (due now). `exists` when it already is; `full` at the limit; `unkeyable` when its address cannot be keyed. */
  register(kind: PluginKind, ref: ChangeRequestRef, now: number): Promise<"registered" | "exists" | "full" | "unkeyable">;
  /** Stops following it. */
  unregister(kind: PluginKind, ref: ChangeRequestRef): Promise<void>;
}

const cursorOf = (value: unknown): PollCursor | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const { state, head, seen } = value as { state?: unknown; head?: unknown; seen?: unknown };
  if ((state !== "open" && state !== "closed" && state !== "merged") || typeof head !== "string" || !Array.isArray(seen) || !seen.every((fact) => typeof fact === "string")) return undefined;
  return { state, head, seen };
};

export function dynamoPollStore(deps: { documentClient: DocumentClient; tableName: string; now: () => number }): PollRegistry {
  const key = (kind: PluginKind, targetId: string) => ({ pk: partition(kind), sk: `T#${targetId}` });
  const items = async (kind: PluginKind): Promise<Array<Record<string, unknown>>> => {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": partition(kind), ":prefix": "T#" },
      ConsistentRead: true, Limit: MAX_POLL_TARGETS + 1,
    })) as { Items?: Array<Record<string, unknown>> };
    return response.Items ?? [];
  };
  return {
    async targets(kind) {
      const found: DuePoll[] = [];
      for (const item of (await items(kind)).slice(0, MAX_POLL_TARGETS)) {
        const ref = ChangeRequestRefSchema.safeParse(item["ref"]);
        if (!ref.success || typeof item["targetId"] !== "string" || typeof item["dueAt"] !== "number" || !Number.isFinite(item["dueAt"])) continue;
        const cursor = item["cursor"] === undefined ? undefined : cursorOf(item["cursor"]);
        // A cursor that is there but cannot be read is a first look again, never a guess.
        found.push({ target: { id: item["targetId"], ref: ref.data }, cursor, dueAt: item["dueAt"], attempts: typeof item["attempts"] === "number" && item["attempts"] >= 0 ? item["attempts"] : 0 });
      }
      return found;
    },
    async save(kind, poll, next) {
      if (next === "done") {
        await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: key(kind, poll.target.id) }));
        return;
      }
      try {
        await deps.documentClient.send(new UpdateCommand({
          TableName: deps.tableName, Key: key(kind, poll.target.id), UpdateExpression: "SET #cursor = :cursor, dueAt = :due, attempts = :attempts, polledAt = :now",
          ConditionExpression: "attribute_exists(pk)", ExpressionAttributeNames: { "#cursor": "cursor" },
          ExpressionAttributeValues: { ":cursor": next.cursor, ":due": next.dueAt, ":attempts": next.attempts, ":now": deps.now() },
        }));
      } catch (error) {
        // Unregistered while it was being polled: nothing to save.
        if (!isConditional(error)) throw error;
      }
    },
    async blockedUntil(kind) {
      const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: partition(kind), sk: "BLOCK" }, ConsistentRead: true })) as { Item?: Record<string, unknown> };
      const until = response.Item?.["blockedUntil"];
      return typeof until === "number" && until > deps.now() ? until : undefined;
    },
    async block(kind, until) {
      try {
        await deps.documentClient.send(new UpdateCommand({
          TableName: deps.tableName, Key: { pk: partition(kind), sk: "BLOCK" }, UpdateExpression: "SET blockedUntil = :until",
          ConditionExpression: "attribute_not_exists(blockedUntil) OR blockedUntil < :until", ExpressionAttributeValues: { ":until": until },
        }));
      } catch (error) {
        // A later limit is already kept.
        if (!isConditional(error)) throw error;
      }
    },
    async register(kind, ref, now) {
      const id = pollTargetId(kind, ref);
      if (id === undefined) return "unkeyable";
      if ((await items(kind)).length >= MAX_POLL_TARGETS) return "full";
      try {
        await deps.documentClient.send(new PutCommand({
          TableName: deps.tableName, ConditionExpression: "attribute_not_exists(pk)",
          Item: { ...key(kind, id), entityType: "CODEHOST_POLL_TARGET", hostKind: kind, targetId: id, ref, dueAt: now, attempts: 0, registeredAt: now },
        }));
        return "registered";
      } catch (error) {
        if (isConditional(error)) return "exists";
        throw error;
      }
    },
    async unregister(kind, ref) {
      const id = pollTargetId(kind, ref);
      if (id !== undefined) await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: key(kind, id) }));
    },
  };
}
