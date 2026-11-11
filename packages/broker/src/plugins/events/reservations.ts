// P6: each neutral code host event is reserved once, by (host kind, event id), before it is consumed. A repeat of an event already consumed is dropped; an id reused with different
// content is a conflict (never silently merged); an event whose earlier attempt did not finish is offered again. The row expires, as an index row does.
import { createHash } from "node:crypto";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, type CodeHostEvent } from "@rovara-code/contracts";
import { isConditional } from "../../aws/broker-shared.js";

export type Reservation = "reserved" | "retry" | "duplicate" | "conflict";

export interface EventReservations {
  /** Reserves the event. `hash` binds the event's whole content to its id. */
  reserve(event: CodeHostEvent, hash: string): Promise<Reservation>;
  /** Marks the event consumed, so a repeat is `duplicate`. */
  complete(event: CodeHostEvent): Promise<void>;
}

/** How long a reservation is kept: longer than any host redelivers, and longer than a poller's repeat of a finding. */
export const EVENT_RESERVATION_RETENTION_SECONDS = 30 * 86_400;

/** A stable digest of an event: the same event always hashes the same, whatever order its keys arrived in. */
export function codeHostEventHash(event: CodeHostEvent): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, inner]) => [key, canonical(inner)]))
    : value;
  return createHash("sha256").update(JSON.stringify(canonical(event)), "utf8").digest("hex");
}

export const codeHostEventKey = (event: Pick<CodeHostEvent, "host" | "eventId">) => ({ pk: `CODEHOST_EVENT#${event.host}#${event.eventId}`, sk: "META" });

export function dynamoEventReservations(deps: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number }): EventReservations {
  return {
    async reserve(event, hash) {
      const key = codeHostEventKey(event);
      if (/[\p{Cc}\p{Cf}]/u.test(key.pk) || event.eventId.includes("#")) return "conflict";
      const receivedAt = new Date(deps.now()).toISOString();
      try {
        await deps.documentClient.send(new PutCommand({
          TableName: deps.tableName, ConditionExpression: "attribute_not_exists(pk)",
          Item: { ...key, entityType: "CODEHOST_EVENT", hostKind: event.host, eventId: event.eventId, eventHash: hash, status: "RECEIVED", receivedAt, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(deps.now() / 1_000) + EVENT_RESERVATION_RETENTION_SECONDS },
        }));
        return "reserved";
      } catch (error) {
        if (!isConditional(error)) throw error;
      }
      const stored = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
      if (stored?.["eventHash"] !== hash || stored["hostKind"] !== event.host) return "conflict";
      return stored["status"] === "COMPLETED" ? "duplicate" : "retry";
    },
    async complete(event) {
      try {
        await deps.documentClient.send(new UpdateCommand({
          TableName: deps.tableName, Key: codeHostEventKey(event), UpdateExpression: "SET #status = :completed, completedAt = :now",
          ConditionExpression: "attribute_exists(pk)", ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":completed": "COMPLETED", ":now": new Date(deps.now()).toISOString() },
        }));
      } catch (error) {
        if (!isConditional(error)) throw error;
      }
    },
  };
}
