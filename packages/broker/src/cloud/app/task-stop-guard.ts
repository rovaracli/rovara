// Switch blocker 2 (money): the switch must not change money behaviour. Cloud's own start captures the task's spending stop (the company's per-task stop policy and the funding-sources pin,
// `captureTaskStopAdmission`, stored on the task and on its operations) for a company that is ENROLLED in per-task stops; for a company that never enrolled it captures nothing (`disabled`).
// The core's start has no place to carry that snapshot: Code's task record and operations are written by Code, and `startExtras` adds items beside them, not fields to them. So:
//   - a company not enrolled: nothing to capture on either engine, and the core's start is the same in money terms (its payer rules and its admission levels are Cloud's, money.ts);
//   - a company enrolled: a NEW task of theirs starts on Cloud's path, exactly as before, until the core can carry the stop. The start hook and the Slack consumer ask this and decline.
// Enrolled is what `captureTaskStopSnapshot` reads as not disabled: the company's `TASK_STOP_POLICY` setting exists, or either seed receipt does (org/task-stop-admission.ts).
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { orgScoped, type OrgId } from "@rovara-code/contracts";
import { orgSettingsKey } from "@agentx/cloud-contracts";

export async function taskStopEnrolled(deps: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }, orgId: OrgId): Promise<boolean> {
  const keys = [orgSettingsKey(orgId, "TASK_STOP_POLICY"), { pk: orgScoped(orgId, "TASK_STOP_SEED"), sk: "V1#bootstrap" }, { pk: orgScoped(orgId, "TASK_STOP_SEED"), sk: "V1#upgrade" }];
  for (const Key of keys) {
    const found = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key, ConsistentRead: true }))) as { Item?: unknown };
    if (found.Item !== undefined) return true;
  }
  return false;
}
