// Table isolation adapter over the existing atomic/condition-validating fake. No weakened realism.
import { FakeDynamoDb } from "./fake-dynamodb.js";
type Item = Record<string, unknown>;
type Command = Parameters<FakeDynamoDb["send"]>[0];
export class TableAwareDynamoDb {
  readonly backing = new FakeDynamoDb();
  beforeTransaction?: (input: Item) => Promise<void>;
  readonly transactions: Item[] = [];
  private pk(table: string, pk: string): string { return JSON.stringify([table, pk]); }
  private key(table: string, value: unknown): Item {
    const key = value as Item;
    if (typeof key.pk !== "string" || typeof key.sk !== "string") throw new Error("Native fake key required");
    return { ...key, pk: this.pk(table, key.pk) };
  }
  private decode(item: Item): Item {
    if (typeof item.pk !== "string") throw new Error("Native fake key required");
    const pair = JSON.parse(item.pk) as [string, string];
    return { ...structuredClone(item), pk: pair[1] };
  }
  set(table: string, item: Item): void { this.backing.set(this.key(table, item)); }
  get(table: string, key: { pk: string; sk: string }): Item | undefined {
    const item = this.backing.get(this.pk(table, key.pk), key.sk); return item === undefined ? undefined : this.decode(item);
  }
  private map(input: Item): Item {
    if (typeof input.TableName !== "string") throw new Error("Native fake table required");
    const table = input.TableName, mapped = structuredClone(input);
    if (mapped.Key !== undefined) mapped.Key = this.key(table, mapped.Key);
    if (mapped.Item !== undefined) mapped.Item = this.key(table, mapped.Item);
    const values = mapped.ExpressionAttributeValues as Item | undefined;
    if (values !== undefined && typeof values[":pk"] === "string") values[":pk"] = this.pk(table, values[":pk"]);
    return mapped;
  }
  send = async (value: unknown): Promise<unknown> => {
    const command = value as Command;
    const input = structuredClone(command.input);
    let mapped: Item;
    if (command.constructor.name === "TransactWriteCommand") {
      this.transactions.push(structuredClone(input)); await this.beforeTransaction?.(input);
      mapped = { ...input, TransactItems: (input.TransactItems as Array<Record<string, Item>>).map(entry => Object.fromEntries(Object.entries(entry).map(([kind, action]) => [kind, this.map(action)]))) };
    } else mapped = this.map(input);
    const result = await this.backing.send({ constructor: { name: command.constructor.name }, input: mapped }) as { Item?: Item; Items?: Item[]; Attributes?: Item };
    return { ...result, ...(result.Item === undefined ? {} : { Item: this.decode(result.Item) }), ...(result.Items === undefined ? {} : { Items: result.Items.map(item => this.decode(item)) }), ...(result.Attributes === undefined ? {} : { Attributes: this.decode(result.Attributes) }) };
  };
}
