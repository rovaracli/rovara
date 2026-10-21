// FakeDynamoDb keeps one store keyed by (pk, sk) and ignores table names. The audit tables are separate in production, and some of
// their keys look alike: the keys table's partition `ORG#<orgId>` is also the State table's org record (`ORG#<orgId>` / `META`).
// A test that must prove one table's sweep leaves the other's items alone needs the tables kept apart, so this wrapper gives
// each table its own namespace in one FakeDynamoDb (a transaction across tables stays one atomic commit in it).
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { FakeDynamoDb } from "./fake-dynamodb.js";

type Item = Record<string, unknown>;
type Input = Record<string, unknown>;
type Command = { constructor: new (input: Input) => unknown; input: Input };

const SEPARATOR = "\u0001";

export class TableScopedDynamoDb {
  readonly fake = new FakeDynamoDb();
  /** Every command sent, in order, with the table(s) it named. */
  readonly sent: Array<{ command: string; tables: string[] }> = [];
  /** Runs before a command is sent; throw to make it fail before it touches anything. */
  before: ((command: { constructor: { name: string }; input: Input }) => void | Promise<void>) | undefined;
  readonly client = { send: (command: Command) => this.send(command) } as unknown as DynamoDBDocumentClient;

  private scope(table: unknown, pk: unknown): string {
    return `${String(table)}${SEPARATOR}${String(pk)}`;
  }

  private unscope(table: string, item: Item | Record<string, unknown> | undefined): Item | undefined {
    if (item === undefined) return undefined;
    const pk = String(item.pk);
    return pk.startsWith(`${table}${SEPARATOR}`) ? { ...item, pk: pk.slice(table.length + 1) } : undefined;
  }

  private scopedKey(table: unknown, key: Input | undefined): Input | undefined {
    return key === undefined ? undefined : { ...key, pk: this.scope(table, key.pk) };
  }

  async send(command: Command): Promise<unknown> {
    await this.before?.(command);
    const name = command.constructor.name;
    const input = command.input;
    if (name === "TransactWriteCommand") {
      const entries = input.TransactItems as Array<Record<string, Input>>;
      const tables = entries.map((entry) => String(Object.values(entry)[0]!.TableName));
      this.sent.push({ command: name, tables });
      const scoped = entries.map((entry) => {
        const [kind, action] = Object.entries(entry)[0] as [string, Input];
        return { [kind]: { ...action, ...(action.Key === undefined ? {} : { Key: this.scopedKey(action.TableName, action.Key as Input) }), ...(action.Item === undefined ? {} : { Item: this.scopedKey(action.TableName, action.Item as Input) }) } };
      });
      return this.fake.send(new command.constructor({ ...input, TransactItems: scoped }) as never);
    }
    const table = String(input.TableName);
    this.sent.push({ command: name, tables: [table] });
    const scoped: Input = {
      ...input,
      ...(input.Key === undefined ? {} : { Key: this.scopedKey(table, input.Key as Input) }),
      ...(input.Item === undefined ? {} : { Item: this.scopedKey(table, input.Item as Input) }),
      ...(input.ExclusiveStartKey === undefined ? {} : { ExclusiveStartKey: this.scopedKey(table, input.ExclusiveStartKey as Input) }),
      ...(name === "QueryCommand" ? { ExpressionAttributeValues: { ...(input.ExpressionAttributeValues as Input), ":pk": this.scope(table, (input.ExpressionAttributeValues as Input)[":pk"]) } } : {}),
    };
    const result = await this.fake.send(new command.constructor(scoped) as never) as Input;
    if (name === "GetCommand") return { ...result, Item: this.unscope(table, result.Item as Item | undefined) };
    if (name === "QueryCommand") {
      return {
        ...result,
        Items: (result.Items as Item[]).map((item) => this.unscope(table, item)),
        ...(result.LastEvaluatedKey === undefined ? {} : { LastEvaluatedKey: this.unscope(table, result.LastEvaluatedKey as Record<string, unknown>) }),
      };
    }
    return result;
  }

  /** One item of `table`, or undefined. */
  get(table: string, pk: string, sk: string): Item | undefined {
    return this.unscope(table, this.fake.get(this.scope(table, pk), sk));
  }

  set(table: string, item: Item): void {
    this.fake.set({ ...item, pk: this.scope(table, item.pk) });
  }

  /** The items of `table` that satisfy `predicate` (the item's own pk, without the namespace). */
  find(table: string, predicate: (item: Item) => boolean = () => true): Item[] {
    return this.fake.find((item) => String(item.pk).startsWith(`${table}${SEPARATOR}`)).map((item) => this.unscope(table, item)!).filter(predicate);
  }

  /** Every item of every table, as text: for a search for a string that must be nowhere. */
  dump(): string {
    return JSON.stringify(this.fake.find(() => true));
  }
}
