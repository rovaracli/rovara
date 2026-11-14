// 058-stop-close (QA6-13): a Stop for a step whose delivery is still waiting for the workspace's compute. Nothing reached a worker, so there is nothing for a worker to stop: asking one
// (the cancel invocation) used to fail with NOT_FOUND, which held the workspace until the reconciler's idle check ten minutes later. The parked delivery is withdrawn instead, in one
// transaction, so it is never sent when the compute comes up; the caller then ends the step as a successful cancel does.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { workspaceSessionKey } from "@rovara-code/contracts";
import { parkedOutboxIds, sessionWaitingKey } from "./sessions.js";

type Client = { send(command: unknown): Promise<unknown> };

/**
 * Withdraws the WAITING_FOR_SESSION delivery of `operationId`, when the workspace's session still holds it parked: the outbox record ends FAILED (it is never re-queued) and leaves the
 * session's parked set, together. Answers whether it did. False when the operation's delivery is not parked (it may be with a worker, or being sent), or moved while this ran: the
 * caller then asks the worker, as before.
 */
export async function withdrawParkedDelivery(client: Client, tableName: string, workspaceId: string, operationId: string): Promise<boolean> {
  const read = async (key: { pk: string; sk: string }) => ((await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  const session = await read(workspaceSessionKey(workspaceId));
  // Both forms (S2): the session's old `waitingOutboxIds` set and the parked markers.
  const ids = session === undefined ? [] : await parkedOutboxIds(client as Parameters<typeof parkedOutboxIds>[0], tableName, workspaceId, session);
  for (const outboxId of ids) {
    const outbox = await read({ pk: `OUTBOX#${outboxId}`, sk: "OUTBOX" });
    if (outbox?.operationId !== operationId || outbox.workspaceId !== workspaceId || outbox.status !== "WAITING_FOR_SESSION") continue;
    const now = new Date().toISOString();
    try {
      await client.send(new TransactWriteCommand({ TransactItems: [
        { Update: {
          TableName: tableName, Key: { pk: `OUTBOX#${outboxId}`, sk: "OUTBOX" },
          UpdateExpression: "SET #status = :failed, failedAt = :now, #error = :error",
          ConditionExpression: "#status = :waiting AND operationId = :operation",
          ExpressionAttributeNames: { "#status": "status", "#error": "error" },
          ExpressionAttributeValues: { ":failed": "FAILED", ":waiting": "WAITING_FOR_SESSION", ":operation": operationId, ":now": now, ":error": "STOPPED_BEFORE_START: the task was stopped before this step was sent to its workspace" },
        } },
        { Update: {
          TableName: tableName, Key: workspaceSessionKey(workspaceId),
          UpdateExpression: "DELETE waitingOutboxIds :id",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeValues: { ":id": new Set([outboxId]) },
        } },
        { Delete: { TableName: tableName, Key: sessionWaitingKey(workspaceId, outboxId) } },
      ] }));
      return true;
    } catch (error) {
      if (error instanceof Error && (error.name === "TransactionCanceledException" || error.name === "ConditionalCheckFailedException")) return false;
      throw error;
    }
  }
  return false;
}
