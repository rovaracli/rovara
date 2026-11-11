// The one request-id pattern of Plan 2 (R18; final review M2). A change that can be repeated carries a request id from the client. The record of
// that id is written in the SAME transaction as the change, bound to the person who made it and expiring with the State table's TTL
// (`indexExpiresAt`). A repeat of the id by the same person answers the stored outcome and writes nothing; the id used by anyone else, or for a
// different body or action, is IDEMPOTENCY_CONFLICT. A record past its expiry (the TTL can lag) is no record: the id is free again, and the
// next write replaces it. Writing the record after the change, without a caller or without an expiry, is what this replaces.
import { GetCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, agentXError, type OrgKey } from "@rovara-code/contracts";

type Send = { send(command: unknown): Promise<unknown> };
export type RequestTransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

/** How long a request id is remembered: a day. */
export const REQUEST_RECORD_SECONDS = 86_400;
export const REQUEST_CONFLICT_MESSAGE = "that request id was already used for a different request; use a new one";

/** The stored record for a request id, or undefined when there is none or it has expired. A consistent read. */
export async function readRequestRecord(client: Send, tableName: string, key: OrgKey, nowMs: number): Promise<Record<string, unknown> | undefined> {
  const stored = ((await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  if (stored === undefined) return undefined;
  const expires = stored[INDEX_EXPIRY_ATTRIBUTE];
  if (typeof expires === "number" && expires <= Math.floor(nowMs / 1000)) return undefined;
  return stored;
}

/** The transaction item that stores the record. It fails only while an unexpired record is there, so a repeat that got in first wins. */
export function requestRecordPut(tableName: string, key: OrgKey, entityType: string, fields: Record<string, unknown>, nowMs: number): RequestTransactItem {
  const seconds = Math.floor(nowMs / 1000);
  return { Put: {
    TableName: tableName,
    Item: { ...key, entityType, ...fields, at: new Date(nowMs).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: seconds + REQUEST_RECORD_SECONDS },
    ConditionExpression: `attribute_not_exists(pk) OR ${INDEX_EXPIRY_ATTRIBUTE} <= :now`,
    ExpressionAttributeValues: { ":now": seconds },
  } };
}

/**
 * Throws IDEMPOTENCY_CONFLICT unless the stored record is this person's and says what this request says (`action` and `bodyHash`, whichever the
 * caller stores). One person can neither replay nor learn about another's request.
 */
export function requireSameRequest(stored: Record<string, unknown>, expected: { by: string; action?: string; bodyHash?: string }, message: string = REQUEST_CONFLICT_MESSAGE): void {
  if (stored.by !== expected.by) throw agentXError("IDEMPOTENCY_CONFLICT", message);
  if (expected.action !== undefined && stored.action !== expected.action) throw agentXError("IDEMPOTENCY_CONFLICT", message);
  if (expected.bodyHash !== undefined && stored.bodyHash !== expected.bodyHash) throw agentXError("IDEMPOTENCY_CONFLICT", message);
}
