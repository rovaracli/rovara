// 0.5.11 (QA6-12b): an approval of a coding plan that raises the run limit names the amount it was shown, from every surface. A test that approves a plan through the API, a token or Slack and is not
// about the acknowledgement spreads this into the decision's body: it carries the amount the task's own record says approving sets, and nothing when approving does not raise the limit.
import { planRunLimitChange } from "../../packages/broker/src/spend/run-limit-change.js";
import type { FakeDynamoDb } from "./fake-dynamodb.js";

export function runLimitAck(db: FakeDynamoDb, taskId: string): { acknowledgedRunLimitUsd?: number } {
  const task = db.get(`DEVTASK#${taskId}`, "META") as Parameters<typeof planRunLimitChange>[0] | undefined;
  const change = task === undefined ? undefined : planRunLimitChange(task);
  return change?.raises === true ? { acknowledgedRunLimitUsd: change.proposedUsd } : {};
}
