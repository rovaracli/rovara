// A tiny in-memory DynamoDB DocumentClient for the TestAccessStore adapter's tests (lane TA2): Get, Query (pk and begins_with(sk)), Update (`SET a = :v`), and TransactWrite with Put, Update and Delete, where a failed
// condition cancels the whole transaction with per-item reasons, as DynamoDB does. It understands exactly the condition forms the adapter writes: attribute_exists(x), attribute_not_exists(x), `x = :v` (with #names) and `x > :v`, joined by AND.
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

type Item = Record<string, unknown>;
type Condition = { ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> };

export class FakeDynamoClient {
  readonly items = new Map<string, Item>();
  readonly sent: string[] = [];
  /** Fails the next transaction with this error before it is applied. */
  failNextTransaction: Error | undefined;
  private key = (item: { pk: unknown; sk: unknown }): string => `${String(item.pk)}\u0000${String(item.sk)}`;

  private holds(existing: Item | undefined, condition: Condition): boolean {
    if (condition.ConditionExpression === undefined) return true;
    const name = (text: string): string => condition.ExpressionAttributeNames?.[text] ?? text;
    return condition.ConditionExpression.split(" AND ").every((term) => {
      let match = /^attribute_exists\((\w+)\)$/u.exec(term);
      if (match !== null) return existing?.[name(match[1] as string)] !== undefined;
      match = /^attribute_not_exists\((\w+)\)$/u.exec(term);
      if (match !== null) return existing?.[name(match[1] as string)] === undefined;
      match = /^([#\w]+) (=|>) (:\w+)$/u.exec(term);
      if (match === null) throw new Error(`the fake does not understand: ${term}`);
      const left = existing?.[name(match[1] as string)];
      const right = condition.ExpressionAttributeValues?.[match[3] as string];
      return match[2] === "=" ? left === right : typeof left === "number" && typeof right === "number" && left > right;
    });
  }

  private apply(operation: Record<string, unknown>): void {
    const put = operation["Put"] as ({ Item: Item } & Condition) | undefined;
    const del = operation["Delete"] as { Key: Item } | undefined;
    const update = operation["Update"] as ({ Key: Item; UpdateExpression: string } & Condition) | undefined;
    if (put !== undefined) this.items.set(this.key(put.Item as { pk: unknown; sk: unknown }), structuredClone(put.Item));
    if (del !== undefined) this.items.delete(this.key(del.Key as { pk: unknown; sk: unknown }));
    if (update !== undefined) {
      const key = this.key(update.Key as { pk: unknown; sk: unknown });
      const match = /^SET (\w+) = (:\w+)$/u.exec(update.UpdateExpression);
      if (match === null) throw new Error("the fake understands only SET a = :v");
      this.items.set(key, { ...(this.items.get(key) ?? update.Key), [match[1] as string]: update.ExpressionAttributeValues?.[match[2] as string] });
    }
  }

  send(command: unknown): Promise<unknown> {
    this.sent.push((command as object).constructor.name);
    if (command instanceof GetCommand) {
      const found = this.items.get(this.key(command.input.Key as { pk: unknown; sk: unknown }));
      return Promise.resolve(found === undefined ? {} : { Item: structuredClone(found) });
    }
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues as Record<string, string>;
      const items = [...this.items.values()].filter((item) => item["pk"] === values[":pk"] && (values[":sk"] === undefined || String(item["sk"]).startsWith(values[":sk"]))).sort((left, right) => String(left["sk"]).localeCompare(String(right["sk"])));
      return Promise.resolve({ Items: items.slice(0, command.input.Limit ?? items.length).map((item) => structuredClone(item)) });
    }
    if (command instanceof PutCommand) {
      const input = command.input as { Item: Item } & Condition;
      if (!this.holds(this.items.get(this.key(input.Item as { pk: unknown; sk: unknown })), input)) return Promise.reject(Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" }));
      this.apply({ Put: input });
      return Promise.resolve({});
    }
    if (command instanceof DeleteCommand) {
      this.apply({ Delete: command.input });
      return Promise.resolve({});
    }
    if (command instanceof UpdateCommand) {
      const input = command.input as { Key: Item; UpdateExpression: string } & Condition;
      if (!this.holds(this.items.get(this.key(input.Key as { pk: unknown; sk: unknown })), input)) return Promise.reject(Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" }));
      this.apply({ Update: input });
      return Promise.resolve({});
    }
    if (command instanceof TransactWriteCommand) {
      if (this.failNextTransaction !== undefined) { const error = this.failNextTransaction; this.failNextTransaction = undefined; return Promise.reject(error); }
      const operations = (command.input.TransactItems ?? []) as Array<Record<string, unknown>>;
      if (operations.length > 100) return Promise.reject(new Error("a transaction holds at most 100 items"));
      const reasons = operations.map((operation) => {
        const body = (operation["Put"] ?? operation["Update"] ?? operation["Delete"]) as ({ Item?: Item; Key?: Item } & Condition);
        const existing = this.items.get(this.key((body.Item ?? body.Key) as { pk: unknown; sk: unknown }));
        return { Code: this.holds(existing, body) ? "None" : "ConditionalCheckFailed" };
      });
      if (reasons.some((reason) => reason.Code !== "None")) return Promise.reject(Object.assign(new Error("Transaction cancelled"), { name: "TransactionCanceledException", CancellationReasons: reasons }));
      for (const operation of operations) this.apply(operation);
      return Promise.resolve({});
    }
    throw new Error(`the fake does not know ${(command as object).constructor.name}`);
  }
}
