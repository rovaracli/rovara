// Work events (U3): the Cloud store. One row per event in the State table, under the company's key scope (`ORG#<org>#WORK_EVENTS#<yyyy-mm>#<shard>`), expiring by the table's TTL attribute 13 months after its month.
// The shape, key and retention rule are the contract's (`@agentx/cloud-contracts` work-event.ts, copied from Code: UPSTREAM OWED, see briefs/work-events.md). The rows follow Code's `core/work-events`, which Cloud
// will import instead of this file once Code has it and the vendor pin includes it.
import { PutCommand, QueryCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { WorkEventInstantSchema, WorkEventSchema, workEventExpiresAt, workEventKey, workEventMonths, workEventPartitions, type WorkEvent, type WorkEventInput, type WorkEventKind } from "@agentx/cloud-contracts";
import { INDEX_EXPIRY_ATTRIBUTE, type OrgId } from "@rovara-code/contracts";

export type TransactItems = NonNullable<TransactWriteCommandInput["TransactItems"]>;
type Client = { send(command: unknown): Promise<unknown> };

/** The stored row of an event: the event, its key, a type marker and the TTL attribute. Throws for an event that is not valid. */
export function workEventRow(input: WorkEventInput): Record<string, unknown> {
  const event = WorkEventSchema.parse(input);
  return JSON.parse(JSON.stringify({ ...workEventKey(event), entityType: "WORK_EVENT", ...event, [INDEX_EXPIRY_ATTRIBUTE]: workEventExpiresAt(event.at) })) as Record<string, unknown>;
}

/**
 * The transaction item for one event (only `cost_settled` rides in a business transaction, the settlement's). NO condition, on purpose: the id comes from the change, so a repeat of the change is the same row, and
 * an event must never be the reason a change is refused (a conditional Put that met its own earlier copy would cancel the whole transaction).
 */
export function workEventPutItem(tableName: string, event: WorkEventInput): TransactItems[number] {
  return { Put: { TableName: tableName, Item: workEventRow(event) } };
}

/** Writes one event on its own (the stream consumer). A repeat of the same event writes the same row. */
export async function putWorkEvent(deps: { documentClient: Client; tableName: string }, event: WorkEventInput): Promise<void> {
  await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: workEventRow(event) }));
}

export interface WorkEventQuery {
  orgId: OrgId;
  /** The range, both ends inclusive, as UTC instants in the form `toISOString` writes. */
  from: string;
  to: string;
  kinds?: readonly WorkEventKind[];
  taskId?: string;
  /** The time rows are judged expired at, epoch milliseconds (default now): the TTL sweep is lazy, so a row past its time may still be there, and is not returned. */
  now?: number;
}

/**
 * The company's events in a range, oldest first, and how many rows could not be read (a version this code does not know). One query per shard for each month in the range; for the rollups and the first Insights
 * read, which are not built yet: nothing reads events in the product now. A row past its expiry is not returned.
 */
export async function listWorkEvents(deps: { documentClient: Client; tableName: string }, query: WorkEventQuery): Promise<{ events: WorkEvent[]; unreadable: number }> {
  WorkEventInstantSchema.parse(query.from);
  WorkEventInstantSchema.parse(query.to);
  const nowSeconds = Math.floor((query.now ?? Date.now()) / 1000);
  const events: WorkEvent[] = [];
  let unreadable = 0;
  for (const month of workEventMonths(query.from, query.to)) {
    for (const pk of workEventPartitions(query.orgId, month)) {
      let startKey: Record<string, unknown> | undefined;
      do {
        // The sort key is `<at>#<id>`: "~" sorts after "#", so `to~` includes every event at `to`.
        const page = await deps.documentClient.send(new QueryCommand({
          TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND sk BETWEEN :low AND :high", ConsistentRead: true,
          ExpressionAttributeValues: { ":pk": pk, ":low": query.from, ":high": `${query.to}~` },
          ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
        })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
        for (const row of page.Items ?? []) {
          const expires = row[INDEX_EXPIRY_ATTRIBUTE];
          if (typeof expires === "number" && expires <= nowSeconds) continue;
          const parsed = WorkEventSchema.safeParse(Object.fromEntries(Object.entries(row).filter(([name]) => !["pk", "sk", "entityType", INDEX_EXPIRY_ATTRIBUTE].includes(name))));
          if (!parsed.success) {
            unreadable += 1;
            continue;
          }
          if (query.kinds !== undefined && !query.kinds.includes(parsed.data.kind)) continue;
          if (query.taskId !== undefined && parsed.data.taskId !== query.taskId) continue;
          events.push(parsed.data);
        }
        startKey = page.LastEvaluatedKey;
      } while (startKey !== undefined);
    }
  }
  events.sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1));
  return { events, unreadable };
}
