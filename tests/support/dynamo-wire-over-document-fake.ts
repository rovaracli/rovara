// S3-10: DynamoDB's wire protocol (the low-level commands Code's DynamoDB document store sends: GetItem, BatchGetItem, PutItem, UpdateItem, DeleteItem, Query, TransactWriteItems) answered by Cloud's
// document-level FakeDynamoDb, so the core's store and Cloud's own readers (the people, the task access rule, the spending-stop reads) share ONE table in a test, as they share the State table in production.
// Attribute values are unmarshalled on the way in and marshalled on the way out; the fake's errors (by name, with CancellationReasons) pass through unchanged.
import { BatchGetItemCommand, DeleteItemCommand, GetItemCommand, PutItemCommand, QueryCommand, TransactWriteItemsCommand, UpdateItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { BatchGetCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand as DocQueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type { FakeDynamoDb } from "./fake-dynamodb.js";

type Wire = Record<string, AttributeValue>;
const down = (value: Wire | undefined): Record<string, unknown> | undefined => (value === undefined ? undefined : unmarshall(value));
const up = (value: Record<string, unknown> | undefined): Wire | undefined => (value === undefined ? undefined : marshall(value, { removeUndefinedValues: true, convertClassInstanceToMap: true }));

/** The expression parts of a request, with its values unmarshalled. */
function expressionParts(input: { ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Wire }): Record<string, unknown> {
  return {
    ...(input.ExpressionAttributeNames === undefined ? {} : { ExpressionAttributeNames: input.ExpressionAttributeNames }),
    ...(input.ExpressionAttributeValues === undefined ? {} : { ExpressionAttributeValues: down(input.ExpressionAttributeValues) }),
  };
}

/** The fields of a low-level request this adapter reads. */
interface WireInput {
  TableName?: string; IndexName?: string; Key?: Wire; Item?: Wire; ExclusiveStartKey?: Wire; ExpressionAttributeValues?: Wire; ExpressionAttributeNames?: Record<string, string>;
  ConditionExpression?: string; UpdateExpression?: string; KeyConditionExpression?: string; FilterExpression?: string; ProjectionExpression?: string; ReturnValues?: string;
  ConsistentRead?: boolean; ScanIndexForward?: boolean; Limit?: number;
  RequestItems?: Record<string, { Keys: Wire[]; ConsistentRead?: boolean }>; TransactItems?: Array<Record<string, WireInput>>;
}

const compare = (left: string, right: string): number => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

/**
 * A query on the table's own keys, in any of the forms the core's store sends (`#k = :v` with `=`, `<`, `<=`, `>`, `>=`, `BETWEEN` or `begins_with` on the sort key): the whole partition is read from the
 * fake (the form it takes), and the sort key range, the order, the start key and the limit are applied here, as DynamoDB applies them. A filter is refused (the core's store sends none on these paths).
 */
async function baseQuery(fake: FakeDynamoDb, input: WireInput): Promise<unknown> {
  const names: Record<string, string> = input.ExpressionAttributeNames ?? {};
  // The one filter the core's store sends on these paths: `attribute_exists(#n)` (a session's live-delivered notes). Anything else is refused, never guessed.
  const exists = input.FilterExpression === undefined ? undefined : /^attribute_exists\((#?\w+)\)$/u.exec(String(input.FilterExpression));
  if (input.FilterExpression !== undefined && exists === null) throw new Error(`the wire adapter does not take the filter ${String(input.FilterExpression)}`);
  const filterAttribute = exists?.[1] === undefined ? undefined : exists[1].startsWith("#") ? names[exists[1]]! : exists[1];
  const values = down(input.ExpressionAttributeValues) ?? {};
  const name = (token: string): string => (token.startsWith("#") ? names[token]! : token);
  const parts = /^(\S+) = (:\S+)(?: AND (?:(\S+) (=|<=|>=|<|>) (:\S+)|(\S+) BETWEEN (:\S+) AND (:\S+)|begins_with\((\S+), (:\S+)\)))?$/u.exec(String(input.KeyConditionExpression));
  if (parts === null || name(parts[1]!) !== "pk") throw new Error(`the wire adapter does not take the key condition ${String(input.KeyConditionExpression)}`);
  const whole = await fake.send(new DocQueryCommand({ TableName: input.TableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": values[parts[2]!] }, ConsistentRead: true })) as { Items?: Array<Record<string, unknown>> };
  let items = (whole.Items ?? []).filter((item) => {
    const sk = String(item["sk"]);
    if (parts[4] !== undefined) { const bound = String(values[parts[5]!]); const order = compare(sk, bound); return parts[4] === "=" ? order === 0 : parts[4] === "<" ? order < 0 : parts[4] === "<=" ? order <= 0 : parts[4] === ">" ? order > 0 : order >= 0; }
    if (parts[7] !== undefined) return compare(sk, String(values[parts[7]])) >= 0 && compare(sk, String(values[parts[8]!])) <= 0;
    if (parts[10] !== undefined) return sk.startsWith(String(values[parts[10]]));
    return true;
  }).filter((item) => filterAttribute === undefined || item[filterAttribute] !== undefined).sort((left, right) => compare(String(left["sk"]), String(right["sk"])));
  if (input.ScanIndexForward === false) items.reverse();
  const start = down(input.ExclusiveStartKey);
  if (start !== undefined) items = items.filter((item) => compare(String(item["sk"]), String(start["sk"])) * (input.ScanIndexForward === false ? -1 : 1) > 0);
  const limit = typeof input.Limit === "number" ? input.Limit : undefined;
  const page = limit === undefined ? items : items.slice(0, limit);
  const more = limit !== undefined && items.length > limit;
  const last = page.at(-1);
  return { Items: page.map((item) => up(item)!), Count: page.length, ...(more && last !== undefined ? { LastEvaluatedKey: up({ pk: last["pk"], sk: last["sk"] }) } : {}) };
}

export function wireOver(fake: FakeDynamoDb): { send(command: unknown): Promise<unknown> } {
  return {
    async send(command: unknown): Promise<unknown> {
      const input = (command as { input: WireInput }).input;
      if (command instanceof GetItemCommand) {
        const answer = await fake.send(new GetCommand({ TableName: input.TableName, Key: down(input.Key)!, ...(input.ConsistentRead === undefined ? {} : { ConsistentRead: input.ConsistentRead }), ...(input.ProjectionExpression === undefined ? {} : { ProjectionExpression: input.ProjectionExpression }), ...expressionParts(input) })) as { Item?: Record<string, unknown> };
        return { Item: up(answer.Item) };
      }
      if (command instanceof BatchGetItemCommand) {
        const request = Object.fromEntries(Object.entries(input.RequestItems ?? {}).map(([table, spec]) => [table, { Keys: spec.Keys.map((key) => down(key)!), ...(spec.ConsistentRead === undefined ? {} : { ConsistentRead: spec.ConsistentRead }) }]));
        const answer = await fake.send(new BatchGetCommand({ RequestItems: request })) as { Responses?: Record<string, Array<Record<string, unknown>>> };
        return { Responses: Object.fromEntries(Object.entries(answer.Responses ?? {}).map(([table, items]) => [table, items.map((item) => up(item)!)])), UnprocessedKeys: {} };
      }
      if (command instanceof PutItemCommand) {
        const answer = await fake.send(new PutCommand({ TableName: input.TableName, Item: down(input.Item)!, ...(input.ConditionExpression === undefined ? {} : { ConditionExpression: input.ConditionExpression }), ...(input.ReturnValues === undefined ? {} : { ReturnValues: input.ReturnValues }), ...expressionParts(input) } as never)) as { Attributes?: Record<string, unknown> };
        return { Attributes: up(answer?.Attributes) };
      }
      if (command instanceof UpdateItemCommand) {
        const answer = await fake.send(new UpdateCommand({ TableName: input.TableName, Key: down(input.Key)!, UpdateExpression: input.UpdateExpression, ...(input.ConditionExpression === undefined ? {} : { ConditionExpression: input.ConditionExpression }), ...(input.ReturnValues === undefined ? {} : { ReturnValues: input.ReturnValues }), ...expressionParts(input) } as never)) as { Attributes?: Record<string, unknown> };
        return { Attributes: up(answer?.Attributes) };
      }
      if (command instanceof DeleteItemCommand) {
        const answer = await fake.send(new DeleteCommand({ TableName: input.TableName, Key: down(input.Key)!, ...(input.ConditionExpression === undefined ? {} : { ConditionExpression: input.ConditionExpression }), ...(input.ReturnValues === undefined ? {} : { ReturnValues: input.ReturnValues }), ...expressionParts(input) } as never)) as { Attributes?: Record<string, unknown> };
        return { Attributes: up(answer?.Attributes) };
      }
      if (command instanceof QueryCommand && input.IndexName === undefined) return await baseQuery(fake, input);
      if (command instanceof QueryCommand) {
        const { ExpressionAttributeValues: _values, ExclusiveStartKey, ...rest } = input; // eslint-disable-line @typescript-eslint/no-unused-vars -- the values are unmarshalled below
        const answer = await fake.send(new DocQueryCommand({ ...rest, ...expressionParts(input), ...(ExclusiveStartKey === undefined ? {} : { ExclusiveStartKey: down(ExclusiveStartKey) }) } as never)) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown>; Count?: number };
        return { Items: (answer.Items ?? []).map((item) => up(item)!), ...(answer.LastEvaluatedKey === undefined ? {} : { LastEvaluatedKey: up(answer.LastEvaluatedKey) }), Count: answer.Items?.length ?? 0 };
      }
      if (command instanceof TransactWriteItemsCommand) {
        const items = (input.TransactItems ?? []).map((entry) => {
          const [kind, spec] = Object.entries(entry)[0]!;
          const base = { TableName: spec.TableName, ...(spec.ConditionExpression === undefined ? {} : { ConditionExpression: spec.ConditionExpression }), ...expressionParts(spec) };
          switch (kind) {
            case "Put": return { Put: { ...base, Item: down(spec.Item) } };
            case "Update": return { Update: { ...base, Key: down(spec.Key), UpdateExpression: spec.UpdateExpression } };
            case "Delete": return { Delete: { ...base, Key: down(spec.Key) } };
            case "ConditionCheck": return { ConditionCheck: { ...base, Key: down(spec.Key) } };
            default: throw new Error(`unsupported transaction item ${kind}`);
          }
        });
        await fake.send(new TransactWriteCommand({ TransactItems: items } as never));
        return {};
      }
      throw new Error(`the wire adapter does not take ${(command as { constructor: { name: string } }).constructor.name}`);
    },
  };
}
