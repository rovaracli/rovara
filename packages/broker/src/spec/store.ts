// K1 lane D, D2: a task's spec state in DynamoDB (the broker's table). An item that is there but is not a state this release reads is `corrupt`: the code pull request is held, never let through.
import { GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { specStateItem, type SpecStore } from "./hooks.js";
import { SpecStateSchema, specStateKey, type SpecState } from "./state.js";

export function dynamoSpecStore(dependencies: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }): SpecStore {
  return {
    load: async (taskId) => {
      const result = await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName, Key: specStateKey(taskId), ConsistentRead: true })) as { Item?: unknown };
      if (result.Item === undefined) return { state: undefined, corrupt: false };
      const parsed = SpecStateSchema.safeParse(result.Item);
      return parsed.success ? { state: parsed.data, corrupt: false } : { state: undefined, corrupt: true };
    },
    force: async (next: SpecState, extra) => {
      try {
        if (extra !== undefined && extra.length > 0) await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: dependencies.tableName, Item: next } }, ...extra] }));
        else await dependencies.documentClient.send(new PutCommand({ TableName: dependencies.tableName, Item: next }));
        return true;
      } catch (error) {
        if (error instanceof Error && error.name === "TransactionCanceledException") return false;
        throw error;
      }
    },
    save: async (next: SpecState, replaces, extra) => {
      try {
        // With `extra` items (an access fence), the state and they commit together or not at all; a failed fence is a lost write, like a lost race.
        if (extra !== undefined && extra.length > 0) {
          await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [specStateItem(dependencies.tableName, next, replaces), ...extra] }));
          return true;
        }
        await dependencies.documentClient.send(new PutCommand({
          TableName: dependencies.tableName, Item: next,
          ...(replaces === undefined
            ? { ConditionExpression: "attribute_not_exists(pk)" }
            : { ConditionExpression: "#revision = :replaces", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":replaces": replaces } }),
        }));
        return true;
      } catch (error) {
        if (error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException")) return false;
        throw error;
      }
    },
  };
}
