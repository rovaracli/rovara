// Lessons in production, lane 2 (M4): a reflection that is past its deadline writes nothing more to the lessons' store. The worker gives its DynamoDB client to the Team record and the lessons through this wrapper:
// once the running attempt's abort signal (`learning-deadline.ts`) is aborted, a write command (put, update, delete, batch or transaction) to one of the guarded tables is refused before it is sent. A write
// already sent finishes on its own (a transaction is all or nothing), so a lesson change is never left half-written by a worker that has been given up on and frozen into a later invocation. Other tables are not
// guarded: the spend ledger must still block and settle the attempt's model keys after the deadline. Outside an attempt (the broker, tests) nothing is refused.
import { currentLearningAttempt } from "./learning-deadline.js";

export const LEARNING_WRITE_DEADLINE = "the reflection ran out of time before this write";

const WRITE_COMMANDS = new Set(["PutCommand", "UpdateCommand", "DeleteCommand", "BatchWriteCommand", "TransactWriteCommand"]);

/** The tables a command writes to. */
function tablesOf(command: { constructor: { name: string }; input?: Record<string, unknown> }): string[] {
  if (!WRITE_COMMANDS.has(command.constructor.name)) return [];
  const input = command.input ?? {};
  const tables: string[] = [];
  if (typeof input["TableName"] === "string") tables.push(input["TableName"]);
  for (const item of Array.isArray(input["TransactItems"]) ? input["TransactItems"] as Array<Record<string, { TableName?: unknown } | undefined>> : []) {
    for (const part of [item["Put"], item["Update"], item["Delete"]]) if (typeof part?.TableName === "string") tables.push(part.TableName);
  }
  if (input["RequestItems"] !== null && typeof input["RequestItems"] === "object") tables.push(...Object.keys(input["RequestItems"]));
  return tables;
}

export function deadlineGuardedClient<T extends { send(command: never, ...rest: never[]): Promise<unknown> }>(client: T, guardedTable: (tableName: string) => boolean): T {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== "send") return Reflect.get(target, property, receiver) as unknown;
      return (command: { constructor: { name: string }; input?: Record<string, unknown> }, ...rest: unknown[]) => {
        if (currentLearningAttempt()?.signal?.aborted === true && tablesOf(command).some(guardedTable)) return Promise.reject(new Error(LEARNING_WRITE_DEADLINE));
        return (target.send as (...args: unknown[]) => Promise<unknown>).call(target, command, ...rest);
      };
    },
  });
}
