// Design review stage, DR7 slice C (DR11 Slack and Linear intake): "design first" typed in a request (`design first: ...`), recorded on the task so the Understand step's mode resolution can read it. The record is the
// person's ask and nothing more: it turns the review on only while the `dr` switch is on for the project, and the company's lock and the high-risk rules apply exactly as they do to the button.
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { taskKey } from "../developer/task-records.js";

export interface DesignFirstRequest { by: string; at: string }

/** Records the ask on a task that was just started. Best effort: a failure leaves the task as a plain one, and the button is still there. */
export async function markDesignFirst(deps: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }, taskId: string, by: string, now: () => string = () => new Date().toISOString()): Promise<void> {
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: taskKey(taskId), UpdateExpression: "SET designFirst = :request", ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(closedAt) AND attribute_not_exists(designFirst)",
      ExpressionAttributeValues: { ":request": { by, at: now() } },
    }));
  } catch { /* a task that cannot be marked runs as a plain one */ }
}
