// What the agent store and the skill store share for writing the State table: the shapes of an item and a transaction item, the
// aliases that keep an attribute name clear of DynamoDB's reserved words, how a cancelled transaction says which item refused, and the
// request item (R18) that makes a write repeatable. Every multi-item write is one transaction, so a refused write leaves nothing behind.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, agentRequestKey, agentXError, type AgentXErrorCode, type OrgId } from "@rovara-code/contracts";

/** How long a request item answers a repeat; the State table's TTL removes it after that, and a repeat later is a new request. */
export const REQUEST_MEMORY_DAYS = 7;
export const NOT_EXISTS = "attribute_not_exists(pk)";
export const EXISTS = "attribute_exists(pk)";

export type Item = Record<string, unknown>;
export type TransactItem = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>[number];

/** Where a store writes. */
export interface TableInput {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
}

/**
 * What makes a write repeatable (R18): the request's id and a fingerprint of what it asked. The store writes one item for it in the
 * same transaction as the change, holding what the change returned (`result`, unless the caller gives its own), so a repeat of the
 * request is answered from that item and writes nothing.
 */
export interface RequestMark {
  orgId: OrgId;
  developerId: string;
  requestId: string;
  fingerprint: string;
  /** Overrides what is remembered, for a write that returns nothing itself. */
  result?: unknown;
}

export const coded = (code: AgentXErrorCode, message: string) => agentXError(code, message);

export const errorName = (error: unknown) => (error instanceof Error ? error.name : undefined);

/** The indexes of the TransactItems whose own condition failed; undefined when the error is not a cancellation. */
export function failedIndexes(error: unknown): Set<number> | undefined {
  if (errorName(error) !== "TransactionCanceledException") return undefined;
  const reasons = (error as { CancellationReasons?: unknown }).CancellationReasons;
  if (!Array.isArray(reasons)) return undefined;
  const failed = new Set<number>();
  reasons.forEach((reason: { Code?: string } | undefined, index) => {
    if (reason?.Code === "ConditionalCheckFailed") failed.add(index);
  });
  return failed;
}

/**
 * Whether a failed write lost only to another transaction touching the same items right now: the whole-call `TransactionConflictException`, or a cancellation
 * with a `TransactionConflict` reason. Nothing was written, no condition failed (`failedIndexes` is empty), and the same write can be tried again.
 */
export function isTransactionConflict(error: unknown): boolean {
  if (errorName(error) === "TransactionConflictException") return true;
  if (errorName(error) !== "TransactionCanceledException") return false;
  const reasons = (error as { CancellationReasons?: unknown }).CancellationReasons;
  return Array.isArray(reasons) && reasons.some((reason: { Code?: string } | undefined) => reason?.Code === "TransactionConflict");
}

export function strip<T extends Item>(item: T): Omit<T, "pk" | "sk" | "entityType"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the keys
  const { pk: _pk, sk: _sk, entityType: _type, ...rest } = item;
  return rest;
}

/** Collects the `#name` and `:value` aliases of one expression, so no attribute name can hit a reserved word. */
export class Aliases {
  readonly names: Record<string, string> = {};
  readonly values: Record<string, unknown> = {};
  private next = 0;

  name(attribute: string): string {
    const existing = Object.entries(this.names).find(([, name]) => name === attribute);
    if (existing) return existing[0];
    const alias = `#n${String(this.next++)}`;
    this.names[alias] = attribute;
    return alias;
  }

  value(value: unknown): string {
    const alias = `:v${String(this.next++)}`;
    this.values[alias] = value;
    return alias;
  }
}

export const withoutUndefined = <T extends Item>(item: T): T => Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined)) as T;

/** A Put of a new item (it must not exist yet). */
export function putNew(table: TableInput, key: { pk: string; sk: string }, entityType: string, fields: Item): TransactItem {
  return { Put: { TableName: table.tableName, Item: { ...key, entityType, ...withoutUndefined(fields) }, ConditionExpression: NOT_EXISTS } };
}

/** An Update of one item: `set` values (undefined skipped), `remove` attributes and a condition built from the same aliases. */
export function updateItem(table: TableInput, key: { pk: string; sk: string }, change: { set?: Item; remove?: string[]; when?: (aliases: Aliases) => string }): TransactItem {
  const aliases = new Aliases();
  const sets = Object.entries(change.set ?? {}).filter(([, value]) => value !== undefined).map(([name, value]) => `${aliases.name(name)} = ${aliases.value(value)}`);
  const removes = (change.remove ?? []).map((name) => aliases.name(name));
  const expression = [sets.length > 0 ? `SET ${sets.join(", ")}` : "", removes.length > 0 ? `REMOVE ${removes.join(", ")}` : ""].filter(Boolean).join(" ");
  const condition = change.when?.(aliases) ?? EXISTS;
  return {
    Update: {
      TableName: table.tableName,
      Key: key,
      UpdateExpression: expression,
      ConditionExpression: condition,
      ExpressionAttributeNames: aliases.names,
      ...(Object.keys(aliases.values).length > 0 ? { ExpressionAttributeValues: aliases.values } : {}),
    },
  };
}

/**
 * An Update that ADDs `delta` to a number attribute that is already there; it never creates the item (the caller makes sure it exists,
 * with the right figure). It applies only while the attribute stays at or above zero after a decrease, and, with `unlessOver`, at or
 * below that limit after an increase, so two writers that together pass a limit can't both apply. Every condition is on the attribute and
 * a value; the comparison with the limit is worked out here (a millionth of slack keeps float dust from refusing an exact fit).
 */
export function addToCounter(table: TableInput, key: { pk: string; sk: string }, attribute: string, delta: number, unlessOver?: number): TransactItem {
  const aliases = new Aliases();
  const name = aliases.name(attribute);
  const amount = aliases.value(delta);
  const conditions = [`attribute_exists(${name})`];
  if (delta < 0) conditions.push(`${name} >= ${aliases.value(Number((-delta - 0.000001).toFixed(6)))}`);
  else if (unlessOver !== undefined) conditions.push(`${name} <= ${aliases.value(Number((unlessOver - delta + 0.000001).toFixed(6)))}`);
  return {
    Update: {
      TableName: table.tableName,
      Key: key,
      UpdateExpression: `ADD ${name} ${amount}`,
      ConditionExpression: conditions.join(" AND "),
      ExpressionAttributeNames: aliases.names,
      ExpressionAttributeValues: aliases.values,
    },
  };
}

/** Sends one transaction; a refused condition becomes the error `refuse` picks from the indexes that failed (or the cancellation itself). */
export async function transact(table: TableInput, items: TransactItem[], refuse: (failed: Set<number>) => Error | undefined): Promise<void> {
  try {
    await table.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    const failed = failedIndexes(error);
    const refusal = failed === undefined ? undefined : refuse(failed);
    throw refusal ?? error;
  }
}

/** The request's own item (R18): written with the change it belongs to, so a repeat of the request finds what the change returned. */
export function requestMarkItem(table: TableInput, request: RequestMark, result?: unknown): TransactItem {
  const remembered = JSON.parse(JSON.stringify(request.result ?? result ?? null)) as unknown;
  const nowSeconds = Math.floor(table.now() / 1000);
  return {
    Put: {
      TableName: table.tableName,
      Item: {
        ...agentRequestKey(request.orgId, request.developerId, request.requestId), entityType: "AGENT_REQUEST",
        fingerprint: request.fingerprint, result: remembered, at: new Date(table.now()).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: nowSeconds + REQUEST_MEMORY_DAYS * 86_400,
      },
      // An expired item the TTL has not removed yet is as good as gone.
      ConditionExpression: "attribute_not_exists(pk) OR #expires <= :now",
      ExpressionAttributeNames: { "#expires": INDEX_EXPIRY_ATTRIBUTE },
      ExpressionAttributeValues: { ":now": nowSeconds },
    },
  };
}

/** What an earlier request of this developer's with this id did, or undefined when it did nothing or its item has expired. */
export async function readRequest(table: TableInput, orgId: OrgId, developerId: string, requestId: string): Promise<{ fingerprint: string; result: unknown } | undefined> {
  const response = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: agentRequestKey(orgId, developerId, requestId), ConsistentRead: true })) as { Item?: Item };
  const earlier = response.Item;
  const expires = earlier?.[INDEX_EXPIRY_ATTRIBUTE];
  if (earlier === undefined || (typeof expires === "number" && expires <= Math.floor(table.now() / 1000))) return undefined;
  return { fingerprint: String(earlier["fingerprint"]), result: earlier["result"] };
}

/** `transact` with the request's own item added: the mark is written with the change or not at all. */
export async function commit(table: TableInput, items: TransactItem[], refuse: (failed: Set<number>) => Error | undefined, request?: RequestMark, result?: unknown): Promise<void> {
  if (request === undefined) return transact(table, items, refuse);
  const at = items.length;
  return transact(table, [...items, requestMarkItem(table, request, result)], (failed) => (failed.has(at) ? coded("IDEMPOTENCY_CONFLICT", "This request ID is already being used for another change.") : refuse(failed)));
}
